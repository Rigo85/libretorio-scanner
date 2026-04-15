#include "helper_archive_utils.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#include <limits.h>
#include <sys/wait.h>
#include <unistd.h>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

static volatile sig_atomic_t cancelled = 0;

struct CliArgs {
    std::string input;
    std::string output;
    std::string mode = "extract-all";
};

struct ProcessResult {
    int exitCode = -1;
    std::string output;
};

struct ListedEntry {
    std::string originalPath;
    std::string archivePath;
};

void signalHandler(int) {
    cancelled = 1;
}

std::string trimLine(std::string line) {
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) {
        line.pop_back();
    }
    return line;
}

std::string formatIndex(int index) {
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%06d", index);
    return std::string(buf);
}

void emitJson(const json& j) {
    std::cout << j.dump() << '\n';
    std::cout.flush();
}

void emitError(const std::string& message) {
    emitJson(json{
        {"type", "error"},
        {"message", message},
    });
}

bool parseArgs(int argc, char* argv[], CliArgs& args) {
    for (int i = 1; i < argc; i++) {
        const std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) args.input = argv[++i];
        else if (arg == "--output" && i + 1 < argc) args.output = argv[++i];
        else if (arg == "--mode" && i + 1 < argc) args.mode = argv[++i];
        else if (arg == "--help" || arg == "-h") return false;
        else return false;
    }
    return !args.input.empty() && !args.output.empty();
}

std::string currentExecutablePath() {
    char buffer[PATH_MAX];
    const ssize_t length = ::readlink("/proc/self/exe", buffer, sizeof(buffer) - 1);
    if (length <= 0) {
        throw std::runtime_error("No se pudo resolver /proc/self/exe");
    }
    buffer[length] = '\0';
    return std::string(buffer);
}

fs::path findBundledUnaceBinary() {
    if (const char* envPath = std::getenv("LIBRETORIO_UNACE_BINARY")) {
        fs::path envBinary(envPath);
        if (fs::exists(envBinary)) return envBinary;
    }

    const fs::path selfPath(currentExecutablePath());
    const fs::path sibling = selfPath.parent_path() / "comic-cache-unace";
    if (fs::exists(sibling)) return sibling;

    throw std::runtime_error("No se encontro comic-cache-unace junto a comic-cache-ace-helper");
}

ProcessResult runProcessCapture(
    const fs::path& executable,
    const std::vector<std::string>& args,
    const std::vector<std::pair<std::string, std::string>>& extraEnv = {}) {
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        throw std::runtime_error("No se pudo crear pipe para proceso hijo");
    }

    const pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        throw std::runtime_error("No se pudo crear proceso hijo");
    }

    if (pid == 0) {
        dup2(pipefd[1], STDOUT_FILENO);
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[0]);
        close(pipefd[1]);

        for (const auto& [key, value] : extraEnv) {
            setenv(key.c_str(), value.c_str(), 1);
        }

        std::vector<char*> argv;
        argv.reserve(args.size() + 2);
        argv.push_back(const_cast<char*>(executable.c_str()));
        for (const auto& arg : args) {
            argv.push_back(const_cast<char*>(arg.c_str()));
        }
        argv.push_back(nullptr);

        execv(executable.c_str(), argv.data());
        _exit(127);
    }

    close(pipefd[1]);

    ProcessResult result;
    char buffer[4096];
    ssize_t bytesRead;
    while ((bytesRead = read(pipefd[0], buffer, sizeof(buffer))) > 0) {
        result.output.append(buffer, static_cast<std::size_t>(bytesRead));
    }
    close(pipefd[0]);

    int status = 0;
    waitpid(pid, &status, 0);
    if (WIFEXITED(status)) {
        result.exitCode = WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        result.exitCode = 128 + WTERMSIG(status);
    }

    return result;
}

std::vector<ListedEntry> listArchiveEntries(const fs::path& unaceBinary, const std::string& archivePath) {
    static const std::string kPrefix = "COMISCOPIO_FILE\t";

    ProcessResult result = runProcessCapture(
        unaceBinary,
        {"v", "-y", "-c-", archivePath},
        {{"COMISCOPIO_UNACE_LIST_PREFIX", kPrefix}});

    if (result.exitCode != 0) {
        throw std::runtime_error("unace no pudo listar el archivo ACE");
    }

    std::vector<ListedEntry> entries;
    std::size_t pos = 0;
    while ((pos = result.output.find(kPrefix, pos)) != std::string::npos) {
        const std::size_t start = pos + kPrefix.size();
        std::size_t end = result.output.find_first_of("\r\n", start);
        if (end == std::string::npos) end = result.output.size();

        const std::string originalPath = trimLine(result.output.substr(start, end - start));
        pos = end;
        const std::string archivePathNormalized = normalizeArchivePath(originalPath);
        if (!isImageArchiveEntry(archivePathNormalized)) continue;

        entries.push_back({originalPath, archivePathNormalized});
    }

    std::sort(entries.begin(), entries.end(), [](const ListedEntry& lhs, const ListedEntry& rhs) {
        return naturalArchivePathLess(lhs.archivePath, rhs.archivePath);
    });

    return entries;
}

std::vector<fs::path> collectRegularFiles(const fs::path& root) {
    std::vector<fs::path> files;
    if (!fs::exists(root)) return files;

    for (const auto& item : fs::recursive_directory_iterator(root)) {
        if (item.is_regular_file()) {
            files.push_back(item.path());
        }
    }
    return files;
}

bool extractSingleEntry(
    const fs::path& unaceBinary,
    const std::string& archivePath,
    const std::string& originalEntryPath,
    const fs::path& workDir,
    fs::path& extractedFile) {
    std::error_code ec;
    fs::remove_all(workDir, ec);
    fs::create_directories(workDir, ec);
    if (ec) return false;

    std::string targetDir = workDir.string();
    if (!targetDir.empty() && targetDir.back() != fs::path::preferred_separator) {
        targetDir.push_back(fs::path::preferred_separator);
    }

    ProcessResult result = runProcessCapture(
        unaceBinary,
        {"e", "-y", "-f", "-c-", archivePath, targetDir, originalEntryPath});

    if (result.exitCode != 0) {
        return false;
    }

    std::vector<fs::path> files = collectRegularFiles(workDir);
    if (files.size() != 1) {
        return false;
    }

    extractedFile = files.front();
    return true;
}

}  // namespace

int main(int argc, char* argv[]) {
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    CliArgs args;
    if (!parseArgs(argc, argv, args) || args.mode != "extract-all") {
        std::cerr << "Usage: " << argv[0] << " --input FILE --output RAW_DIR [--mode extract-all]\n";
        return 1;
    }

    try {
        const fs::path rawDir(args.output);
        const fs::path tempRoot = rawDir.parent_path() / ".ace-work";
        const fs::path unaceBinary = findBundledUnaceBinary();

        std::error_code ec;
        fs::create_directories(rawDir, ec);
        if (ec) {
            emitError("No se pudo crear el directorio raw para ACE");
            return 1;
        }

        fs::remove_all(tempRoot, ec);
        fs::create_directories(tempRoot, ec);
        if (ec) {
            emitError("No se pudo crear el directorio temporal de trabajo ACE");
            return 1;
        }

        std::vector<ListedEntry> entries = listArchiveEntries(unaceBinary, args.input);
        if (entries.empty()) {
            emitError("El archivo ACE no contiene imagenes reconocidas");
            fs::remove_all(tempRoot, ec);
            return 1;
        }

        emitJson(json{
            {"type", "archive"},
            {"totalPages", static_cast<int>(entries.size())},
        });

        int failedCount = 0;
        for (std::size_t i = 0; i < entries.size(); i++) {
            if (cancelled) {
                fs::remove_all(tempRoot, ec);
                return 130;
            }

            const auto& entry = entries[i];
            emitJson(json{
                {"type", "extracting"},
                {"current", static_cast<int>(i)},
                {"total", static_cast<int>(entries.size())},
                {"name", entry.archivePath},
            });

            const fs::path workDir = tempRoot / formatIndex(static_cast<int>(i));
            fs::path extractedFile;
            std::string rawFile;

            if (extractSingleEntry(unaceBinary, args.input, entry.originalPath, workDir, extractedFile)) {
                std::string ext = archiveExtension(entry.archivePath);
                if (ext.empty()) ext = ".bin";

                rawFile = formatIndex(static_cast<int>(i)) + ext;
                const fs::path finalPath = rawDir / rawFile;

                std::error_code moveEc;
                fs::rename(extractedFile, finalPath, moveEc);
                if (moveEc) {
                    fs::copy_file(extractedFile, finalPath, fs::copy_options::overwrite_existing, moveEc);
                    if (!moveEc) {
                        fs::remove(extractedFile, moveEc);
                    }
                }
                if (moveEc) {
                    rawFile.clear();
                    failedCount++;
                }
            } else {
                failedCount++;
            }

            emitJson(json{
                {"type", "entry"},
                {"index", static_cast<int>(i)},
                {"name", entry.archivePath},
                {"rawFile", rawFile},
            });

            fs::remove_all(workDir, ec);
        }

        fs::remove_all(tempRoot, ec);
        emitJson(json{
            {"type", "done"},
            {"failed", failedCount},
        });
        return 0;
    } catch (const std::exception& e) {
        emitError(e.what());
        return 1;
    }
}

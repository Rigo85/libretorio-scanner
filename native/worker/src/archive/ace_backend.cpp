#include "archive_backend.h"
#include "archive_entry_utils.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <unordered_map>
#include <utility>
#include <vector>

#ifndef _WIN32
#include <limits.h>
#include <poll.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

struct HelperProcess {
#ifndef _WIN32
    pid_t pid = -1;
    int stdoutFd = -1;
    int stderrFd = -1;
#endif
};

struct ProcessResult {
    int exitCode = -1;
    std::string output;
};

struct SortedAssignment {
    int sortedIndex = 0;
    CanonicalArchiveEntry entry;
};

using AssignmentMap = std::unordered_map<std::string, std::deque<SortedAssignment>>;

std::string trimLine(std::string line) {
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n')) {
        line.pop_back();
    }
    return line;
}

#ifndef _WIN32
std::string currentExecutablePath() {
    char buffer[PATH_MAX];
    const ssize_t length = ::readlink("/proc/self/exe", buffer, sizeof(buffer) - 1);
    if (length <= 0) {
        throw std::runtime_error("Unable to resolve /proc/self/exe");
    }
    buffer[length] = '\0';
    return std::string(buffer);
}

fs::path findSiblingBinary(const char* envName, const char* executableName) {
    if (const char* envPath = std::getenv(envName)) {
        fs::path envBinary(envPath);
        if (fs::exists(envBinary)) {
            return envBinary;
        }
    }

    const fs::path sibling = fs::path(currentExecutablePath()).parent_path() / executableName;
    if (fs::exists(sibling)) {
        return sibling;
    }

    throw std::runtime_error(std::string(executableName) + " not found next to comic-cache-worker");
}

ProcessResult runProcessCapture(
    const fs::path& executable,
    const std::vector<std::string>& args,
    const std::vector<std::pair<std::string, std::string>>& extraEnv = {}) {
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        throw std::runtime_error("Failed to create pipe for ACE helper process");
    }

    const pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        throw std::runtime_error("Failed to spawn ACE child process");
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

HelperProcess spawnHelper(const fs::path& executable, const std::vector<std::string>& args) {
    int stdoutPipe[2];
    int stderrPipe[2];
    if (pipe(stdoutPipe) != 0 || pipe(stderrPipe) != 0) {
        throw std::runtime_error("Failed to create ACE helper pipes");
    }

    const pid_t pid = fork();
    if (pid < 0) {
        close(stdoutPipe[0]);
        close(stdoutPipe[1]);
        close(stderrPipe[0]);
        close(stderrPipe[1]);
        throw std::runtime_error("Failed to spawn ACE helper");
    }

    if (pid == 0) {
        setpgid(0, 0);
        dup2(stdoutPipe[1], STDOUT_FILENO);
        dup2(stderrPipe[1], STDERR_FILENO);

        close(stdoutPipe[0]);
        close(stdoutPipe[1]);
        close(stderrPipe[0]);
        close(stderrPipe[1]);

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

    setpgid(pid, pid);
    close(stdoutPipe[1]);
    close(stderrPipe[1]);

    HelperProcess process;
    process.pid = pid;
    process.stdoutFd = stdoutPipe[0];
    process.stderrFd = stderrPipe[0];
    return process;
}

void killHelperProcess(const HelperProcess& process) {
    if (process.pid > 0) {
        kill(-process.pid, SIGTERM);
    }
}

std::string readAvailable(int fd, bool& closed) {
    std::string out;
    char buffer[4096];
    while (true) {
        const ssize_t bytesRead = ::read(fd, buffer, sizeof(buffer));
        if (bytesRead > 0) {
            out.append(buffer, static_cast<std::size_t>(bytesRead));
            if (bytesRead < static_cast<ssize_t>(sizeof(buffer))) {
                break;
            }
            continue;
        }
        if (bytesRead == 0) {
            closed = true;
        }
        break;
    }
    return out;
}

fs::path createTemporaryDirectory() {
    std::string pattern = (fs::temp_directory_path() / "libretorio-ace-XXXXXX").string();
    std::vector<char> writable(pattern.begin(), pattern.end());
    writable.push_back('\0');
    char* created = mkdtemp(writable.data());
    if (!created) {
        throw std::runtime_error("Failed to create ACE temporary directory");
    }
    return fs::path(created);
}
#endif

AssignmentMap buildAssignmentMap(const std::vector<CanonicalArchiveEntry>& entries) {
    AssignmentMap assignments;
    for (std::size_t index = 0; index < entries.size(); index++) {
        assignments[entries[index].archivePath].push_back(SortedAssignment{
            static_cast<int>(index),
            entries[index]
        });
    }
    return assignments;
}

std::vector<CanonicalArchiveEntry> listAceEntries(const fs::path& unaceBinary, const std::string& archivePath) {
    static const std::string kPrefix = "COMISCOPIO_FILE\t";

    ProcessResult result = runProcessCapture(
        unaceBinary,
        {"v", "-y", "-c-", archivePath},
        {{"COMISCOPIO_UNACE_LIST_PREFIX", kPrefix}});

    if (result.exitCode != 0) {
        throw std::runtime_error("Failed to list ACE archive");
    }

    std::vector<CanonicalArchiveEntry> entries;
    std::vector<std::string> acceptedSamples;
    std::vector<std::string> rejectedSamples;
    int imageCount = 0;
    int junkCount = 0;
    int nonImageCount = 0;

    std::size_t pos = 0;
    while ((pos = result.output.find(kPrefix, pos)) != std::string::npos) {
        const std::size_t start = pos + kPrefix.size();
        std::size_t end = result.output.find_first_of("\r\n", start);
        if (end == std::string::npos) {
            end = result.output.size();
        }

        const std::string originalPath = trimLine(result.output.substr(start, end - start));
        pos = end;

        const std::string archivePathNormalized = normalizeArchivePath(originalPath);
        if (isJunkArchiveEntry(archivePathNormalized)) {
            junkCount++;
            if (rejectedSamples.size() < 5) {
                rejectedSamples.push_back(archivePathNormalized + " [junk]");
            }
            continue;
        }

        if (!isImageArchiveEntry(archivePathNormalized)) {
            nonImageCount++;
            if (rejectedSamples.size() < 5) {
                rejectedSamples.push_back(archivePathNormalized + " [ext=" + archiveExtension(archivePathNormalized) + "]");
            }
            continue;
        }

        std::string extension = archiveExtension(archivePathNormalized);
        if (extension.empty()) {
            extension = ".bin";
        }

        entries.push_back({
            archivePathNormalized,
            archivePathNormalized,
            extension
        });
        imageCount++;
        if (acceptedSamples.size() < 5) {
            acceptedSamples.push_back(archivePathNormalized);
        }
    }

    archiveDebugLog(
        std::string("ACE listEntries summary archive=\"") + archivePath +
        "\" images=" + std::to_string(imageCount) +
        " junk=" + std::to_string(junkCount) +
        " nonImage=" + std::to_string(nonImageCount) +
        " sampleAccepted=" + archiveDebugJoinSamples(acceptedSamples) +
        " sampleRejected=" + archiveDebugJoinSamples(rejectedSamples)
    );

    return sortEntries(std::move(entries));
}

std::vector<uint8_t> readFileBytes(const fs::path& filePath) {
    const auto fileSize = fs::file_size(filePath);
    std::vector<uint8_t> data(static_cast<std::size_t>(fileSize));
    std::ifstream input(filePath, std::ios::binary);
    if (!input) {
        throw std::runtime_error("Failed to open extracted ACE entry: " + filePath.string());
    }
    input.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(fileSize));
    if (!input.good() && !input.eof()) {
        throw std::runtime_error("Failed to read extracted ACE entry: " + filePath.string());
    }
    return data;
}

}  // namespace

class AceBackend : public ArchiveBackend {
public:
    std::vector<CanonicalArchiveEntry> listEntries(const std::string& archivePath) override {
#ifdef _WIN32
        throw std::runtime_error("ACE backend is not supported on Windows");
#else
        return listAceEntries(findUnaceBinary(), archivePath);
#endif
    }

    int processEntries(const std::string& archivePath,
                       const std::vector<CanonicalArchiveEntry>& entries,
                       const EntryProcessor& processor,
                       const WarningCb& warningCb,
                       ProgressCb progressCb,
                       void* userData) override {
#ifdef _WIN32
        throw std::runtime_error("ACE backend is not supported on Windows");
#else
        const fs::path helperBinary = findHelperBinary();
        const fs::path tempRoot = createTemporaryDirectory();
        const fs::path rawDir = tempRoot / "raw";
        auto* cancelContext = reinterpret_cast<ArchiveCancelContext*>(userData);
        cancelFlag = cancelContext ? cancelContext->flag : nullptr;

        AssignmentMap assignments = buildAssignmentMap(entries);
        int processedCount = 0;
        int warnedCount = 0;
        int unmatchedEntryCount = 0;
        int helperFailedCount = 0;
        std::vector<std::string> warningSamples;
        std::vector<std::string> unmatchedSamples;

        archiveDebugLog(
            std::string("ACE processEntries start archive=\"") + archivePath +
            "\" requestedEntries=" + std::to_string(entries.size()) +
            " assignmentKeys=" + std::to_string(assignments.size())
        );

        try {
            HelperProcess process = spawnHelper(helperBinary, {
                "--input", archivePath,
                "--output", rawDir.string(),
                "--mode", "extract-all",
            });

            std::string stdoutBuffer;
            std::string stderrBuffer;
            std::string lastError;
            bool stdoutClosed = false;
            bool stderrClosed = false;
            bool helperExited = false;
            bool done = false;
            int helperStatus = 0;

            auto processStdoutLine = [&](const std::string& line) {
                if (line.empty()) {
                    return;
                }

                json event;
                try {
                    event = json::parse(line);
                } catch (...) {
                    return;
                }

                const std::string type = event.value("type", "");
                if (type == "extracting") {
                    if (progressCb) {
                        progressCb(
                            event.value("current", 0),
                            event.value("total", -1),
                            normalizeArchivePath(event.value("name", std::string{})),
                            userData
                        );
                    }
                    return;
                }

                if (type == "entry") {
                    const std::string archiveName = normalizeArchivePath(event.value("name", std::string{}));
                    auto assignmentIt = assignments.find(archiveName);
                    if (assignmentIt == assignments.end() || assignmentIt->second.empty()) {
                        unmatchedEntryCount++;
                        if (unmatchedSamples.size() < 5) {
                            unmatchedSamples.push_back(archiveName);
                        }
                        return;
                    }

                    SortedAssignment assignment = assignmentIt->second.front();
                    assignmentIt->second.pop_front();

                    const std::string rawFile = event.value("rawFile", std::string{});
                    if (rawFile.empty()) {
                        warnedCount++;
                        if (warningSamples.size() < 5) {
                            warningSamples.push_back(archiveName);
                        }
                        if (warningCb) {
                            warningCb(
                                assignment.sortedIndex,
                                assignment.entry,
                                "Failed to extract ACE entry: " + archiveName
                            );
                        }
                        return;
                    }

                    const fs::path rawPath = rawDir / rawFile;
                    if (!fs::exists(rawPath) || !fs::is_regular_file(rawPath)) {
                        warnedCount++;
                        if (warningSamples.size() < 5) {
                            warningSamples.push_back(archiveName + " [missing-raw]");
                        }
                        if (warningCb) {
                            warningCb(
                                assignment.sortedIndex,
                                assignment.entry,
                                "Extracted ACE entry is missing on disk: " + archiveName
                            );
                        }
                        return;
                    }

                    try {
                        processor(assignment.sortedIndex, assignment.entry, readFileBytes(rawPath));
                        processedCount++;
                    } catch (...) {
                        throw;
                    }
                    return;
                }

                if (type == "error") {
                    lastError = event.value("message", std::string("ACE helper failed"));
                    return;
                }

                if (type == "done") {
                    done = true;
                    helperFailedCount = event.value("failed", 0);
                }
            };

            while (!(helperExited && stdoutClosed && stderrClosed)) {
                if (cancelFlag && *cancelFlag != 0) {
                    killHelperProcess(process);
                    waitpid(process.pid, &helperStatus, 0);
                    ::close(process.stdoutFd);
                    ::close(process.stderrFd);
                    cancelFlag = nullptr;
                    throw std::runtime_error("ACE extraction cancelled");
                }

                struct pollfd fds[2];
                fds[0].fd = process.stdoutFd;
                fds[0].events = stdoutClosed ? 0 : (POLLIN | POLLHUP);
                fds[0].revents = 0;
                fds[1].fd = process.stderrFd;
                fds[1].events = stderrClosed ? 0 : (POLLIN | POLLHUP);
                fds[1].revents = 0;

                const int pollResult = poll(fds, 2, 100);
                if (pollResult > 0) {
                    if (!stdoutClosed && (fds[0].revents & (POLLIN | POLLHUP))) {
                        bool justClosed = false;
                        stdoutBuffer += readAvailable(process.stdoutFd, justClosed);
                        if (justClosed) {
                            ::close(process.stdoutFd);
                            stdoutClosed = true;
                        }
                        std::size_t pos = 0;
                        while ((pos = stdoutBuffer.find('\n')) != std::string::npos) {
                            const std::string line = trimLine(stdoutBuffer.substr(0, pos));
                            stdoutBuffer.erase(0, pos + 1);
                            processStdoutLine(line);
                        }
                    }

                    if (!stderrClosed && (fds[1].revents & (POLLIN | POLLHUP))) {
                        bool justClosed = false;
                        stderrBuffer += readAvailable(process.stderrFd, justClosed);
                        if (justClosed) {
                            ::close(process.stderrFd);
                            stderrClosed = true;
                        }
                    }
                }

                if (!helperExited) {
                    const pid_t waitResult = waitpid(process.pid, &helperStatus, WNOHANG);
                    if (waitResult == process.pid) {
                        helperExited = true;
                    }
                }
            }

            cancelFlag = nullptr;

            if (!stdoutBuffer.empty()) {
                processStdoutLine(trimLine(stdoutBuffer));
            }

            if (!helperExited) {
                waitpid(process.pid, &helperStatus, 0);
            }

            const bool exitedOk = WIFEXITED(helperStatus) && WEXITSTATUS(helperStatus) == 0;
            if (!exitedOk) {
                if (lastError.empty()) {
                    lastError = !stderrBuffer.empty() ? trimLine(stderrBuffer) : "ACE helper exited with error";
                }
                throw std::runtime_error(lastError);
            }

            if (!done) {
                throw std::runtime_error("ACE helper ended without completion event");
            }

            archiveDebugLog(
                std::string("ACE processEntries summary archive=\"") + archivePath +
                "\" processed=" + std::to_string(processedCount) +
                " warned=" + std::to_string(warnedCount) +
                " helperFailed=" + std::to_string(helperFailedCount) +
                " unmatched=" + std::to_string(unmatchedEntryCount) +
                " warningSamples=" + archiveDebugJoinSamples(warningSamples) +
                " unmatchedSamples=" + archiveDebugJoinSamples(unmatchedSamples)
            );

            std::error_code cleanupError;
            fs::remove_all(tempRoot, cleanupError);
            return processedCount;
        } catch (...) {
            cancelFlag = nullptr;
            std::error_code cleanupError;
            fs::remove_all(tempRoot, cleanupError);
            throw;
        }
#endif
    }

    void close() override {
        cancelFlag = nullptr;
    }

private:
#ifndef _WIN32
    fs::path findHelperBinary() const {
        return findSiblingBinary("LIBRETORIO_ACE_HELPER_BINARY", "comic-cache-ace-helper");
    }

    fs::path findUnaceBinary() const {
        return findSiblingBinary("LIBRETORIO_UNACE_BINARY", "comic-cache-unace");
    }
#endif

    volatile sig_atomic_t* cancelFlag = nullptr;
};

std::unique_ptr<ArchiveBackend> createAceBackend() {
    return std::make_unique<AceBackend>();
}

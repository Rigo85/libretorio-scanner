#include "archive_backend.h"
#include "archive_entry_utils.h"
#include "image_pipeline.h"

#include <vips/vips.h>

#include <algorithm>
#include <array>
#include <clocale>
#include <cstdlib>
#include <csignal>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace fs = std::filesystem;

std::unique_ptr<ArchiveBackend> createRarBackend();
std::unique_ptr<ArchiveBackend> createZipBackend();
std::unique_ptr<ArchiveBackend> createSevenZBackend();
std::unique_ptr<ArchiveBackend> createTarBackend();
std::unique_ptr<ArchiveBackend> createAceBackend();

namespace {

enum class BackendKind {
    Unknown,
    Ace,
    Rar,
    Zip,
    SevenZ,
    Tar,
    Directory,
};

struct CliArgs {
    std::string input;
    std::string inputDir;
    std::string output;
    std::string backend = "auto";
    bool debugArchive = false;
    std::string readerFormat = "jpeg";
    int readerMaxDimension = 2400;
    int readerQuality = 82;
    int vipsConcurrency = 1;
};

struct ManifestPage {
    int index = 0;
    std::string originalName;
    std::string raw;
    int originalWidth = 0;
    int originalHeight = 0;
    int outputWidth = 0;
    int outputHeight = 0;
    bool bypassed = false;
};

struct ManifestWarning {
    int index = 0;
    std::string originalName;
    std::string message;
};

struct WorkerResult {
    int pageCount = 0;
    BackendKind backend = BackendKind::Unknown;
    std::string manifestPath;
};

struct DirectoryImageEntry {
    CanonicalArchiveEntry entry;
    fs::path sourcePath;
};

volatile sig_atomic_t cancelled = 0;

void signalHandler(int) {
    cancelled = 1;
}

std::string jsonEscape(const std::string& value) {
    std::string escaped;
    escaped.reserve(value.size() + 8);

    for (const char ch : value) {
        switch (ch) {
            case '\\':
                escaped += "\\\\";
                break;
            case '"':
                escaped += "\\\"";
                break;
            case '\n':
                escaped += "\\n";
                break;
            case '\r':
                escaped += "\\r";
                break;
            case '\t':
                escaped += "\\t";
                break;
            default:
                escaped.push_back(ch);
                break;
        }
    }

    return escaped;
}

std::string formatIndex(int index) {
    char buffer[16];
    std::snprintf(buffer, sizeof(buffer), "%06d", index);
    return buffer;
}

void emitEvent(const std::string& type, const std::string& payload) {
    std::cout << "{\"type\":\"" << type << "\"";
    if (!payload.empty()) {
        std::cout << "," << payload;
    }
    std::cout << "}" << std::endl;
}

void printUsage(const char* program) {
    std::cerr
        << "Usage: " << program
        << " (--input FILE [--backend auto|ace|rar|zip|7z|tar] | --input-dir DIR)"
        << " --output DIR"
        << " [--reader-format jpeg|webp]"
        << " [--reader-max-dimension INT]"
        << " [--reader-quality INT]"
        << " [--vips-concurrency INT]"
        << " [--debug-archive]"
        << std::endl;
}

bool parseArgs(int argc, char* argv[], CliArgs& args) {
    for (int index = 1; index < argc; index++) {
        const std::string arg = argv[index];
        if (arg == "--input" && index + 1 < argc) {
            args.input = argv[++index];
            continue;
        }
        if (arg == "--input-dir" && index + 1 < argc) {
            args.inputDir = argv[++index];
            continue;
        }
        if (arg == "--output" && index + 1 < argc) {
            args.output = argv[++index];
            continue;
        }
        if (arg == "--backend" && index + 1 < argc) {
            args.backend = argv[++index];
            continue;
        }
        if (arg == "--debug-archive") {
            args.debugArchive = true;
            continue;
        }
        if (arg == "--reader-format" && index + 1 < argc) {
            args.readerFormat = argv[++index];
            continue;
        }
        if (arg == "--reader-max-dimension" && index + 1 < argc) {
            args.readerMaxDimension = std::atoi(argv[++index]);
            continue;
        }
        if (arg == "--reader-quality" && index + 1 < argc) {
            args.readerQuality = std::atoi(argv[++index]);
            continue;
        }
        if (arg == "--vips-concurrency" && index + 1 < argc) {
            args.vipsConcurrency = std::atoi(argv[++index]);
            continue;
        }
        if (arg == "--help" || arg == "-h") {
            printUsage(argv[0]);
            return false;
        }

        std::cerr << "Unknown argument: " << arg << std::endl;
        return false;
    }

    const bool hasArchiveInput = !args.input.empty();
    const bool hasDirectoryInput = !args.inputDir.empty();

    if (args.output.empty() || hasArchiveInput == hasDirectoryInput) {
        printUsage(argv[0]);
        return false;
    }

    return true;
}

BackendKind parseBackendKind(const std::string& value) {
    if (value == "ace") return BackendKind::Ace;
    if (value == "rar") return BackendKind::Rar;
    if (value == "zip") return BackendKind::Zip;
    if (value == "7z") return BackendKind::SevenZ;
    if (value == "tar") return BackendKind::Tar;
    if (value == "directory") return BackendKind::Directory;
    return BackendKind::Unknown;
}

const char* backendName(BackendKind backend) {
    switch (backend) {
        case BackendKind::Ace:
            return "ace";
        case BackendKind::Rar:
            return "rar";
        case BackendKind::Zip:
            return "zip";
        case BackendKind::SevenZ:
            return "7z";
        case BackendKind::Tar:
            return "tar";
        case BackendKind::Directory:
            return "directory";
        default:
            return "unknown";
    }
}

BackendKind detectBackendByExtension(const std::string& inputPath) {
    std::string ext = fs::path(inputPath).extension().string();
    std::transform(ext.begin(), ext.end(), ext.begin(), [](const unsigned char value) {
        return static_cast<char>(std::tolower(value));
    });

    if (ext == ".ace" || ext == ".cba") return BackendKind::Ace;
    if (ext == ".cbr" || ext == ".rar") return BackendKind::Rar;
    if (ext == ".cbz" || ext == ".zip") return BackendKind::Zip;
    if (ext == ".cb7" || ext == ".7z") return BackendKind::SevenZ;
    if (ext == ".cbt" || ext == ".tar" || ext == ".tgz" || ext == ".tbz2" || ext == ".txz") return BackendKind::Tar;
    return BackendKind::Unknown;
}

BackendKind detectBackendByMagic(const std::string& inputPath) {
    std::ifstream input(inputPath, std::ios::binary);
    if (!input) {
        return BackendKind::Unknown;
    }

    std::array<unsigned char, 512> header{};
    input.read(reinterpret_cast<char*>(header.data()), static_cast<std::streamsize>(header.size()));
    const std::streamsize bytesRead = input.gcount();

    if (bytesRead >= 7) {
        const std::array<unsigned char, 7> ace = {'*', '*', 'A', 'C', 'E', '*', '*'};
        const auto headerEnd = header.begin() + bytesRead;
        if (std::search(header.begin(), headerEnd, ace.begin(), ace.end()) != headerEnd) {
            return BackendKind::Ace;
        }
    }

    if (bytesRead >= 7) {
        const std::array<unsigned char, 7> rar4 = {0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00};
        const std::array<unsigned char, 8> rar5 = {0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00};
        if (std::equal(rar4.begin(), rar4.end(), header.begin())) return BackendKind::Rar;
        if (bytesRead >= 8 && std::equal(rar5.begin(), rar5.end(), header.begin())) return BackendKind::Rar;
    }

    if (bytesRead >= 4 &&
        header[0] == 0x50 &&
        header[1] == 0x4b &&
        (header[2] == 0x03 || header[2] == 0x05 || header[2] == 0x07) &&
        (header[3] == 0x04 || header[3] == 0x06 || header[3] == 0x08)) {
        return BackendKind::Zip;
    }

    if (bytesRead >= 6) {
        const std::array<unsigned char, 6> sevenZip = {0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c};
        const std::array<unsigned char, 6> xz = {0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00};
        if (std::equal(sevenZip.begin(), sevenZip.end(), header.begin())) return BackendKind::SevenZ;
        if (std::equal(xz.begin(), xz.end(), header.begin())) return BackendKind::Tar;
    }

    if (bytesRead >= 262) {
        const std::string ustar(reinterpret_cast<const char*>(header.data() + 257), 5);
        if (ustar == "ustar") return BackendKind::Tar;
    }

    if (bytesRead >= 2 && header[0] == 0x1f && header[1] == 0x8b) return BackendKind::Tar;
    if (bytesRead >= 3 && header[0] == 0x42 && header[1] == 0x5a && header[2] == 0x68) return BackendKind::Tar;

    return BackendKind::Unknown;
}

BackendKind resolveBackend(const CliArgs& args) {
    const BackendKind requested = parseBackendKind(args.backend);
    const BackendKind detected = detectBackendByMagic(args.input);

    if (detected != BackendKind::Unknown) {
        if (requested != BackendKind::Unknown && requested != detected) {
            emitEvent("warning",
                "\"message\":\"backend_mismatch\",\"requested\":\"" + std::string(backendName(requested)) +
                "\",\"detected\":\"" + backendName(detected) + "\"");
        }
        return detected;
    }

    if (requested != BackendKind::Unknown) {
        return requested;
    }

    return detectBackendByExtension(args.input);
}

std::unique_ptr<ArchiveBackend> createBackend(BackendKind backend) {
    switch (backend) {
        case BackendKind::Rar:
            return createRarBackend();
        case BackendKind::Ace:
            return createAceBackend();
        case BackendKind::Zip:
            return createZipBackend();
        case BackendKind::SevenZ:
            return createSevenZBackend();
        case BackendKind::Tar:
            return createTarBackend();
        default:
            return nullptr;
    }
}

void ensureDirectory(const fs::path& pathValue) {
    std::error_code error;
    fs::create_directories(pathValue, error);
    if (error) {
        throw std::runtime_error("Failed to create output directory: " + error.message());
    }
}

std::vector<uint8_t> readFileBytes(const fs::path& sourcePath) {
    const auto fileSize = fs::file_size(sourcePath);
    std::vector<uint8_t> data(static_cast<std::size_t>(fileSize));
    std::ifstream input(sourcePath, std::ios::binary);
    if (!input) {
        throw std::runtime_error("Failed to open source image: " + sourcePath.string());
    }
    input.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(fileSize));
    if (!input.good() && !input.eof()) {
        throw std::runtime_error("Failed to read source image: " + sourcePath.string());
    }
    return data;
}

std::vector<DirectoryImageEntry> collectDirectoryEntries(const fs::path& rootDir) {
    std::vector<DirectoryImageEntry> entries;

    if (!fs::exists(rootDir) || !fs::is_directory(rootDir)) {
        throw std::runtime_error("Input directory does not exist or is not a directory");
    }

    for (const auto& entry : fs::recursive_directory_iterator(rootDir)) {
        if (!entry.is_regular_file()) {
            continue;
        }

        const fs::path relativePath = fs::relative(entry.path(), rootDir);
        const std::string archivePath = normalizeArchivePath(relativePath.generic_string());
        if (!isImageArchiveEntry(archivePath)) {
            continue;
        }

        std::string extension = archiveExtension(archivePath);
        if (extension.empty()) {
            extension = ".bin";
        }

        entries.push_back({
            {archivePath, archivePath, extension},
            entry.path()
        });
    }

    std::sort(entries.begin(), entries.end(), [](const DirectoryImageEntry& left, const DirectoryImageEntry& right) {
        return naturalArchivePathLess(left.entry.sortKey, right.entry.sortKey);
    });

    return entries;
}

ManifestPage processPageToRaw(
    int sortedIndex,
    const CanonicalArchiveEntry& entry,
    const std::vector<uint8_t>& data,
    const fs::path& rawDir,
    const ImageConfig& config
) {
    const std::string indexValue = formatIndex(sortedIndex);
    const std::string outputStem = (rawDir / indexValue).string();
    const ImageResult result = processImage(data, entry.archivePath, config, outputStem);
    if (!result.ok) {
        throw std::runtime_error("Failed to process image \"" + entry.archivePath + "\": " + result.errorMessage);
    }

    return {
        sortedIndex,
        entry.archivePath,
        std::string("raw/") + indexValue + result.outputExtension,
        result.originalWidth,
        result.originalHeight,
        result.outputWidth,
        result.outputHeight,
        result.bypassed
    };
}

std::string writeManifest(
    const fs::path& outputDir,
    const std::string& source,
    BackendKind backend,
    const ImageConfig& config,
    const std::vector<ManifestPage>& pages,
    const std::vector<ManifestWarning>& warnings,
    const std::string& status = "complete",
    int requestedPages = -1
) {
    const fs::path manifestPath = outputDir / "manifest.json";
    std::ofstream manifest(manifestPath, std::ios::binary | std::ios::trunc);
    if (!manifest) {
        throw std::runtime_error("Failed to open worker manifest for writing");
    }

    manifest << "{\n";
    manifest << "  \"version\": 1,\n";
    manifest << "  \"source\": \"" << jsonEscape(source) << "\",\n";
    manifest << "  \"backend\": \"" << backendName(backend) << "\",\n";
    manifest << "  \"status\": \"" << jsonEscape(status) << "\",\n";
    manifest << "  \"config\": {\n";
    manifest << "    \"readerMaxDimension\": " << config.readerMaxDimension << ",\n";
    manifest << "    \"readerQuality\": " << config.readerQuality << ",\n";
    manifest << "    \"readerFormat\": \"" << jsonEscape(config.readerFormat) << "\",\n";
    manifest << "    \"vipsConcurrency\": " << config.vipsConcurrency << "\n";
    manifest << "  },\n";
    if (requestedPages >= 0) {
        manifest << "  \"requestedPages\": " << requestedPages << ",\n";
        manifest << "  \"droppedPages\": " << (requestedPages - static_cast<int>(pages.size())) << ",\n";
    }
    manifest << "  \"warningCount\": " << warnings.size() << ",\n";
    manifest << "  \"totalPages\": " << pages.size() << ",\n";
    manifest << "  \"pages\": [\n";

    for (std::size_t index = 0; index < pages.size(); index++) {
        const ManifestPage& page = pages[index];
        manifest << "    {"
                 << "\"index\": " << page.index
                 << ", \"originalName\": \"" << jsonEscape(page.originalName) << "\""
                 << ", \"raw\": \"" << jsonEscape(page.raw) << "\""
                 << ", \"originalWidth\": " << page.originalWidth
                 << ", \"originalHeight\": " << page.originalHeight
                 << ", \"outputWidth\": " << page.outputWidth
                 << ", \"outputHeight\": " << page.outputHeight
                 << ", \"bypassed\": " << (page.bypassed ? "true" : "false")
                 << "}";
        if (index + 1 < pages.size()) {
            manifest << ",";
        }
        manifest << "\n";
    }

    manifest << "  ],\n";
    manifest << "  \"warnings\": [\n";

    for (std::size_t index = 0; index < warnings.size(); index++) {
        const ManifestWarning& warning = warnings[index];
        manifest << "    {"
                 << "\"index\": " << warning.index
                 << ", \"originalName\": \"" << jsonEscape(warning.originalName) << "\""
                 << ", \"message\": \"" << jsonEscape(warning.message) << "\""
                 << "}";
        if (index + 1 < warnings.size()) {
            manifest << ",";
        }
        manifest << "\n";
    }

    manifest << "  ]\n";
    manifest << "}\n";
    return manifestPath.string();
}

void validateCliArgs(const CliArgs& args) {
    if (args.readerFormat != "jpeg" && args.readerFormat != "webp") {
        throw std::runtime_error("Unsupported reader format");
    }
    if (args.readerMaxDimension < 512) {
        throw std::runtime_error("readerMaxDimension must be >= 512");
    }
    if (args.readerQuality < 1 || args.readerQuality > 100) {
        throw std::runtime_error("readerQuality must be between 1 and 100");
    }
    if (args.vipsConcurrency < 1) {
        throw std::runtime_error("vipsConcurrency must be >= 1");
    }
}

WorkerResult processDirectoryInput(const CliArgs& args, const ImageConfig& config) {
    const fs::path outputDir(args.output);
    const fs::path rawDir = outputDir / "raw";
    const std::vector<DirectoryImageEntry> entries = collectDirectoryEntries(args.inputDir);
    if (entries.empty()) {
        throw std::runtime_error("No image entries found in directory");
    }

    emitEvent("start",
        "\"backend\":\"directory\",\"input\":\"" + jsonEscape(args.inputDir) +
        "\",\"output\":\"" + jsonEscape(args.output) + "\"");

    std::vector<std::optional<ManifestPage>> processedPages(entries.size());
    std::vector<ManifestWarning> manifestWarnings;
    for (std::size_t index = 0; index < entries.size(); index++) {
        if (cancelled) {
            break;
        }

        const DirectoryImageEntry& entry = entries[index];
        try {
            const std::vector<uint8_t> data = readFileBytes(entry.sourcePath);
            processedPages[index] = processPageToRaw(static_cast<int>(index), entry.entry, data, rawDir, config);
        } catch (const std::exception& error) {
            const std::string message = error.what();
            manifestWarnings.push_back({
                static_cast<int>(index),
                entry.entry.archivePath,
                message,
            });
            std::cerr
                << "Skipped directory page after read/image-processing failure: "
                << entry.entry.archivePath
                << " (" << message << ")"
                << std::endl;
            emitEvent(
                "warning",
                "\"message\":\"Dropped directory page after read/image-processing failure\","
                "\"entry\":\"" + jsonEscape(entry.entry.archivePath) + "\","
                "\"index\":" + std::to_string(index + 1)
            );
        }
        emitEvent("extracting",
            "\"current\":" + std::to_string(index + 1) +
            ",\"total\":" + std::to_string(entries.size()) +
            ",\"name\":\"" + jsonEscape(entry.entry.archivePath) + "\"");
    }

    if (cancelled) {
        throw std::runtime_error("cancelled");
    }

    std::vector<ManifestPage> pages;
    pages.reserve(processedPages.size());
    for (auto& page : processedPages) {
        if (page.has_value()) {
            pages.push_back(std::move(page.value()));
        }
    }

    if (pages.empty()) {
        throw std::runtime_error("No usable image entries remained after processing directory");
    }

    const int droppedPages = static_cast<int>(entries.size() - pages.size());
    const std::string status = droppedPages > 0 ? "partial" : "complete";
    if (droppedPages > 0) {
        emitEvent(
            "warning",
            "\"message\":\"Dropped " + std::to_string(droppedPages) +
            " directory page(s) after read/image-processing failure\""
        );
    }

    const std::string manifestPath = writeManifest(
        outputDir,
        args.inputDir,
        BackendKind::Directory,
        config,
        pages,
        manifestWarnings,
        status,
        static_cast<int>(entries.size())
    );
    return {
        static_cast<int>(pages.size()),
        BackendKind::Directory,
        manifestPath
    };
}

WorkerResult processArchiveInput(const CliArgs& args, const ImageConfig& config) {
    const BackendKind backend = resolveBackend(args);
    if (backend == BackendKind::Unknown) {
        throw std::runtime_error("Unsupported archive format");
    }

    std::unique_ptr<ArchiveBackend> archiveBackend = createBackend(backend);
    if (!archiveBackend) {
        throw std::runtime_error("Could not initialize archive backend");
    }

    const std::vector<CanonicalArchiveEntry> entries = archiveBackend->listEntries(args.input);
    if (entries.empty()) {
        throw std::runtime_error("No image entries found in archive");
    }

    emitEvent("start",
        "\"backend\":\"" + std::string(backendName(backend)) +
        "\",\"input\":\"" + jsonEscape(args.input) +
        "\",\"output\":\"" + jsonEscape(args.output) + "\"");

    const fs::path rawDir = fs::path(args.output) / "raw";
    std::vector<std::optional<ManifestPage>> processedPages(entries.size());
    std::vector<ManifestWarning> manifestWarnings;
    ArchiveCancelContext cancelContext{&cancelled};

    archiveBackend->processEntries(
        args.input,
        entries,
        [&](int sortedIndex, const CanonicalArchiveEntry& entry, std::vector<uint8_t>&& data) {
            try {
                processedPages[sortedIndex] = processPageToRaw(sortedIndex, entry, data, rawDir, config);
            } catch (const std::exception& error) {
                const std::string message = error.what();
                manifestWarnings.push_back({
                    sortedIndex,
                    entry.archivePath,
                    message,
                });
                std::cerr
                    << "Skipped archive page after image-processing failure: "
                    << entry.archivePath
                    << " (" << message << ")"
                    << std::endl;
                emitEvent(
                    "warning",
                    "\"message\":\"Dropped archive page after image-processing failure\","
                    "\"entry\":\"" + jsonEscape(entry.archivePath) + "\","
                    "\"index\":" + std::to_string(sortedIndex + 1)
                );
            }
        },
        [&](int sortedIndex, const CanonicalArchiveEntry& entry, const std::string& message) {
            manifestWarnings.push_back({
                sortedIndex,
                entry.archivePath,
                message,
            });
            emitEvent(
                "warning",
                "\"message\":\"Dropped archive page after extraction/read failure\","
                "\"entry\":\"" + jsonEscape(entry.archivePath) + "\","
                "\"index\":" + std::to_string(sortedIndex + 1)
            );
        },
        [](int current, int total, const std::string& name, void*) {
            emitEvent("extracting",
                "\"current\":" + std::to_string(current + 1) +
                ",\"total\":" + std::to_string(total) +
                ",\"name\":\"" + jsonEscape(name) + "\"");
        },
        &cancelContext
    );
    archiveBackend->close();

    if (cancelled) {
        throw std::runtime_error("cancelled");
    }

    std::vector<ManifestPage> pages;
    pages.reserve(processedPages.size());
    for (auto& page : processedPages) {
        if (page.has_value()) {
            pages.push_back(std::move(page.value()));
        }
    }

    if (pages.empty()) {
        throw std::runtime_error("No extractable image entries remained after processing archive");
    }

    const int droppedPages = static_cast<int>(entries.size() - pages.size());
    const std::string status = droppedPages > 0 ? "partial" : "complete";
    if (droppedPages > 0) {
        emitEvent("warning",
            "\"message\":\"Dropped " + std::to_string(droppedPages) +
            " archive page(s) after extraction/processing failure\""
        );
    }

    const std::string manifestPath = writeManifest(
        args.output,
        args.input,
        backend,
        config,
        pages,
        manifestWarnings,
        status,
        static_cast<int>(entries.size())
    );
    return {
        static_cast<int>(pages.size()),
        backend,
        manifestPath
    };
}

}  // namespace

int main(int argc, char* argv[]) {
    CliArgs args;
    if (!parseArgs(argc, argv, args)) {
        return 1;
    }

    try {
        if (!std::setlocale(LC_CTYPE, "")) {
            std::setlocale(LC_CTYPE, "C.UTF-8");
        }
        validateCliArgs(args);
        setArchiveDebugEnabled(args.debugArchive);

        signal(SIGTERM, signalHandler);
        signal(SIGINT, signalHandler);
        cancelled = 0;

        if (VIPS_INIT(argv[0]) != 0) {
            throw std::runtime_error("vips_init_failed");
        }

        vips_concurrency_set(args.vipsConcurrency);
        vips_cache_set_max(100);
        vips_cache_set_max_mem(64 * 1024 * 1024);
        vips_cache_set_max_files(20);

        if (fs::exists(args.output)) {
            fs::remove_all(args.output);
        }
        ensureDirectory(args.output);
        ensureDirectory(fs::path(args.output) / "raw");

        ImageConfig config;
        config.readerMaxDimension = args.readerMaxDimension;
        config.readerQuality = args.readerQuality;
        config.readerFormat = args.readerFormat;
        config.vipsConcurrency = args.vipsConcurrency;

        const WorkerResult result = !args.inputDir.empty()
            ? processDirectoryInput(args, config)
            : processArchiveInput(args, config);

        emitEvent("complete",
            "\"backend\":\"" + std::string(backendName(result.backend)) +
            "\",\"pages\":" + std::to_string(result.pageCount) +
            ",\"manifestPath\":\"" + jsonEscape(result.manifestPath) + "\"");

        vips_shutdown();
        return 0;
    } catch (const std::exception& error) {
        emitEvent("error", "\"message\":\"" + jsonEscape(error.what()) + "\"");
        std::cerr << error.what() << std::endl;
        vips_shutdown();
        return 2;
    }
}

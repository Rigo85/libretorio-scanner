#include "archive_backend.h"
#include "archive_entry_utils.h"

#include <algorithm>
#include <cstdint>
#include <deque>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

extern "C" {
#include "7z.h"
#include "7zAlloc.h"
#include "7zCrc.h"
#include "7zFile.h"
}

namespace {

static const ISzAlloc kSevenZipAlloc = {SzAlloc, SzFree};

struct SevenZipIndexedEntry {
    UInt32 archiveIndex = 0;
    CanonicalArchiveEntry entry;
};

using AssignmentMap = std::unordered_map<std::string, std::deque<std::pair<int, CanonicalArchiveEntry>>>;

AssignmentMap buildAssignmentMap(const std::vector<CanonicalArchiveEntry>& entries) {
    AssignmentMap assignments;
    for (std::size_t index = 0; index < entries.size(); index++) {
        assignments[entries[index].archivePath].push_back({
            static_cast<int>(index),
            entries[index],
        });
    }
    return assignments;
}

bool isCancelled(void* userData) {
    auto* ctx = reinterpret_cast<ArchiveCancelContext*>(userData);
    return ctx && ctx->flag && *ctx->flag != 0;
}

size_t utf16ToUtf8Calc(const UInt16* src, const UInt16* srcLim) {
    size_t size = 0;
    while (src != srcLim) {
        UInt32 value = *src++;
        size++;

        if (value < 0x80) continue;
        if (value < (1u << 11)) {
            size++;
            continue;
        }

        if (value >= 0xD800 && value < 0xDC00 && src != srcLim) {
            const UInt32 c2 = *src;
            if (c2 >= 0xDC00 && c2 < 0xE000) {
                src++;
                size += 3;
                continue;
            }
        }

        size += 2;
    }
    return size;
}

std::string utf16ToUtf8(const UInt16* src, size_t len) {
    std::string out;
    out.resize(utf16ToUtf8Calc(src, src + len));
    size_t offset = 0;

    while (len > 0) {
        UInt32 value = *src++;
        len--;

        if (value < 0x80) {
            out[offset++] = static_cast<char>(value);
            continue;
        }

        if (value < (1u << 11)) {
            out[offset++] = static_cast<char>(0xC0 | (value >> 6));
            out[offset++] = static_cast<char>(0x80 | (value & 0x3F));
            continue;
        }

        if (value >= 0xD800 && value < 0xDC00 && len > 0) {
            const UInt32 c2 = *src;
            if (c2 >= 0xDC00 && c2 < 0xE000) {
                src++;
                len--;
                value = (((value - 0xD800) << 10) | (c2 - 0xDC00)) + 0x10000;
                out[offset++] = static_cast<char>(0xF0 | (value >> 18));
                out[offset++] = static_cast<char>(0x80 | ((value >> 12) & 0x3F));
                out[offset++] = static_cast<char>(0x80 | ((value >> 6) & 0x3F));
                out[offset++] = static_cast<char>(0x80 | (value & 0x3F));
                continue;
            }
        }

        out[offset++] = static_cast<char>(0xE0 | (value >> 12));
        out[offset++] = static_cast<char>(0x80 | ((value >> 6) & 0x3F));
        out[offset++] = static_cast<char>(0x80 | (value & 0x3F));
    }

    return out;
}

class SevenZipReader {
public:
    explicit SevenZipReader(const std::string& archivePath) {
        CrcGenerateTable();
        File_Construct(&archiveStream.file);
        SzArEx_Init(&db);

        const WRes openResult = InFile_Open(&archiveStream.file, archivePath.c_str());
        if (openResult != 0) {
            throw std::runtime_error("Failed to open 7z archive: " + archivePath);
        }

        FileInStream_CreateVTable(&archiveStream);
        archiveStream.wres = 0;
        LookToRead2_CreateVTable(&lookStream, False);
        lookStream.buf = static_cast<Byte*>(ISzAlloc_Alloc(&allocMain, kInputBufSize));
        if (!lookStream.buf) {
            throw std::runtime_error("Failed to allocate 7z input buffer");
        }

        lookStream.bufSize = kInputBufSize;
        lookStream.realStream = &archiveStream.vt;
        LookToRead2_INIT(&lookStream);

        const SRes result = SzArEx_Open(&db, &lookStream.vt, &allocMain, &allocTemp);
        if (result != SZ_OK) {
            throw std::runtime_error("Failed to parse 7z archive");
        }
    }

    ~SevenZipReader() {
        ISzAlloc_Free(&allocMain, outBuffer);
        SzArEx_Free(&db, &allocMain);
        ISzAlloc_Free(&allocMain, lookStream.buf);
        File_Close(&archiveStream.file);
    }

    UInt32 fileCount() const {
        return db.NumFiles;
    }

    bool isDir(UInt32 index) const {
        return SzArEx_IsDir(&db, index) != 0;
    }

    std::string fileName(UInt32 index) const {
        const size_t required = SzArEx_GetFileNameUtf16(&db, index, nullptr);
        if (required == 0) {
            return "";
        }

        std::vector<UInt16> wide(required);
        SzArEx_GetFileNameUtf16(&db, index, wide.data());

        size_t actualLen = 0;
        while (actualLen < wide.size() && wide[actualLen] != 0) {
            actualLen++;
        }

        return utf16ToUtf8(wide.data(), actualLen);
    }

    bool extractToMemory(UInt32 index, std::vector<uint8_t>& outData) {
        size_t offset = 0;
        size_t outSizeProcessed = 0;

        const SRes result = SzArEx_Extract(
            &db,
            &lookStream.vt,
            index,
            &blockIndex,
            &outBuffer,
            &outBufferSize,
            &offset,
            &outSizeProcessed,
            &allocMain,
            &allocTemp);

        if (result != SZ_OK) {
            return false;
        }

        outData.assign(outBuffer + offset, outBuffer + offset + outSizeProcessed);
        return true;
    }

private:
    static constexpr size_t kInputBufSize = static_cast<size_t>(1) << 18;

    ISzAlloc allocMain = kSevenZipAlloc;
    ISzAlloc allocTemp = kSevenZipAlloc;
    CFileInStream archiveStream{};
    CLookToRead2 lookStream{};
    CSzArEx db{};
    UInt32 blockIndex = 0xFFFFFFFF;
    Byte* outBuffer = nullptr;
    size_t outBufferSize = 0;
};

std::vector<SevenZipIndexedEntry> collectSevenZipImageEntries(SevenZipReader& reader, const std::string& archivePath) {
    std::vector<SevenZipIndexedEntry> entries;
    entries.reserve(reader.fileCount());

    int directoryCount = 0;
    int emptyNameCount = 0;
    int junkCount = 0;
    int nonImageCount = 0;
    std::vector<std::string> acceptedSamples;
    std::vector<std::string> rejectedSamples;

    for (UInt32 index = 0; index < reader.fileCount(); index++) {
        if (reader.isDir(index)) {
            directoryCount++;
            continue;
        }

        const std::string rawName = reader.fileName(index);
        const std::string normalized = normalizeArchivePath(rawName);

        if (normalized.empty()) {
            emptyNameCount++;
            if (rejectedSamples.size() < 5) {
                rejectedSamples.push_back("<empty-name>");
            }
            continue;
        }

        if (isJunkArchiveEntry(normalized)) {
            junkCount++;
            if (rejectedSamples.size() < 5) {
                rejectedSamples.push_back(normalized + " [junk]");
            }
            continue;
        }

        if (!isImageArchiveEntry(normalized)) {
            nonImageCount++;
            if (rejectedSamples.size() < 5) {
                rejectedSamples.push_back(normalized + " [ext=" + archiveExtension(normalized) + "]");
            }
            continue;
        }

        std::string extension = archiveExtension(normalized);
        if (extension.empty()) {
            extension = ".bin";
        }

        entries.push_back({
            index,
            {
                normalized,
                normalized,
                extension,
            },
        });
        if (acceptedSamples.size() < 5) {
            acceptedSamples.push_back(normalized);
        }
    }

    std::sort(entries.begin(), entries.end(), [](const SevenZipIndexedEntry& lhs, const SevenZipIndexedEntry& rhs) {
        return naturalArchivePathLess(lhs.entry.sortKey, rhs.entry.sortKey);
    });

    archiveDebugLog(
        std::string("7Z SDK listEntries summary archive=\"") + archivePath +
        "\" files=" + std::to_string(reader.fileCount()) +
        " directories=" + std::to_string(directoryCount) +
        " images=" + std::to_string(entries.size()) +
        " junk=" + std::to_string(junkCount) +
        " emptyName=" + std::to_string(emptyNameCount) +
        " nonImage=" + std::to_string(nonImageCount) +
        " sampleAccepted=" + archiveDebugJoinSamples(acceptedSamples) +
        " sampleRejected=" + archiveDebugJoinSamples(rejectedSamples)
    );

    return entries;
}

}  // namespace

class SevenZBackend : public ArchiveBackend {
public:
    std::vector<CanonicalArchiveEntry> listEntries(const std::string& archivePath) override {
        SevenZipReader reader(archivePath);
        auto indexedEntries = collectSevenZipImageEntries(reader, archivePath);

        std::vector<CanonicalArchiveEntry> entries;
        entries.reserve(indexedEntries.size());
        for (auto& indexed : indexedEntries) {
            entries.push_back(indexed.entry);
        }
        return entries;
    }

    int processEntries(const std::string& archivePath,
                       const std::vector<CanonicalArchiveEntry>& entries,
                       const EntryProcessor& processor,
                       const WarningCb& warningCb,
                       ProgressCb progressCb,
                       void* userData) override {
        SevenZipReader reader(archivePath);
        auto indexedEntries = collectSevenZipImageEntries(reader, archivePath);
        AssignmentMap assignments = buildAssignmentMap(entries);
        int processedCount = 0;
        int unmatchedCount = 0;
        std::vector<std::string> unmatchedSamples;

        archiveDebugLog(
            std::string("7Z SDK processEntries start archive=\"") + archivePath +
            "\" requestedEntries=" + std::to_string(entries.size()) +
            " indexedEntries=" + std::to_string(indexedEntries.size()) +
            " assignmentKeys=" + std::to_string(assignments.size())
        );

        for (const auto& indexed : indexedEntries) {
            if (isCancelled(userData)) {
                break;
            }

            auto assignmentIt = assignments.find(indexed.entry.archivePath);
            if (assignmentIt == assignments.end() || assignmentIt->second.empty()) {
                unmatchedCount++;
                if (unmatchedSamples.size() < 5) {
                    unmatchedSamples.push_back(indexed.entry.archivePath);
                }
                continue;
            }

            auto assignment = assignmentIt->second.front();
            assignmentIt->second.pop_front();

            std::vector<uint8_t> data;
            if (!reader.extractToMemory(indexed.archiveIndex, data)) {
                archiveDebugLog(
                    std::string("7Z SDK processEntries extract_failure archive=\"") + archivePath +
                    "\" entry=\"" + indexed.entry.archivePath + "\" archiveIndex=" + std::to_string(indexed.archiveIndex)
                );
                const std::string message = "Failed to extract 7z entry: " + indexed.entry.archivePath;
                std::cerr << "Skipped 7z entry due to extraction failure: " << indexed.entry.archivePath << std::endl;
                if (warningCb) {
                    warningCb(assignment.first, assignment.second, message);
                }
                continue;
            }

            processor(assignment.first, assignment.second, std::move(data));

            if (progressCb) {
                progressCb(assignment.first, static_cast<int>(entries.size()), assignment.second.archivePath, userData);
            }
            processedCount++;
        }

        archiveDebugLog(
            std::string("7Z SDK processEntries summary archive=\"") + archivePath +
            "\" requestedEntries=" + std::to_string(entries.size()) +
            " processed=" + std::to_string(processedCount) +
            " unmatched=" + std::to_string(unmatchedCount) +
            " sampleUnmatched=" + archiveDebugJoinSamples(unmatchedSamples)
        );

        return processedCount;
    }

    void close() override {}
};

std::unique_ptr<ArchiveBackend> createSevenZBackend() {
    return std::make_unique<SevenZBackend>();
}

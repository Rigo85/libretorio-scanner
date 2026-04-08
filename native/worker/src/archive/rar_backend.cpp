#include "archive_backend.h"
#include "archive_entry_utils.h"
#include "unrar_compat.h"

#include <cstdint>
#include <codecvt>
#include <deque>
#include <locale>
#include <memory>
#include <iostream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

std::string rarEntryNameUtf8(const RARHeaderDataEx& header) {
    if (header.FileNameW[0] != 0) {
        try {
            std::wstring_convert<std::codecvt_utf8<wchar_t>> convert;
            const std::string utf8 = convert.to_bytes(header.FileNameW);
            if (!utf8.empty()) {
                return normalizeArchivePath(utf8);
            }
        } catch (...) {
        }
    }
    return normalizeArchivePath(header.FileName);
}

struct SortedAssignment {
    int sortedIndex = 0;
    CanonicalArchiveEntry entry;
};

using AssignmentMap = std::unordered_map<std::string, std::deque<SortedAssignment>>;

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

std::uint64_t combineRarSize(uint32_t low, uint32_t high) {
    return (static_cast<std::uint64_t>(high) << 32U) | static_cast<std::uint64_t>(low);
}

}  // namespace

class RarBackend : public ArchiveBackend {
public:
    std::vector<CanonicalArchiveEntry> listEntries(const std::string& archivePath) override {
        std::vector<CanonicalArchiveEntry> entries;
        std::vector<std::string> acceptedSamples;
        std::vector<std::string> rejectedSamples;
        int headerCount = 0;
        int directoryCount = 0;
        int imageCount = 0;
        int junkCount = 0;
        int nonImageCount = 0;
        openArchive(archivePath, [&](HANDLE hArc) {
            RARHeaderDataEx header{};
            int readStatus = 0;
            while ((readStatus = RARReadHeaderEx(hArc, &header)) == 0) {
                headerCount++;
                std::string name = rarEntryNameUtf8(header);
                const bool isDir = (header.Flags & RHDF_DIRECTORY) != 0;
                if (isDir) {
                    directoryCount++;
                } else if (isJunkArchiveEntry(name)) {
                    junkCount++;
                    if (rejectedSamples.size() < 5) {
                        rejectedSamples.push_back(name + " [junk]");
                    }
                } else if (isImageArchiveEntry(name)) {
                    std::string extension = archiveExtension(name);
                    if (extension.empty()) {
                        extension = ".bin";
                    }
                    entries.push_back({name, name, extension});
                    imageCount++;
                    if (acceptedSamples.size() < 5) {
                        acceptedSamples.push_back(name);
                    }
                } else {
                    nonImageCount++;
                    if (rejectedSamples.size() < 5) {
                        rejectedSamples.push_back(name + " [ext=" + archiveExtension(name) + "]");
                    }
                }
                const int skipResult = RARProcessFile(hArc, RAR_SKIP, nullptr, nullptr);
                if (skipResult != 0) {
                    archiveDebugLog(
                        std::string("RAR listEntries skip_failure archive=\"") + archivePath +
                        "\" entry=\"" + name + "\" result=" + std::to_string(skipResult)
                    );
                    throw std::runtime_error(
                        "Failed to skip RAR entry while listing: " + name + " (result=" + std::to_string(skipResult) + ")"
                    );
                }
            }
            archiveDebugLog(
                std::string("RAR listEntries summary archive=\"") + archivePath +
                "\" headers=" + std::to_string(headerCount) +
                " directories=" + std::to_string(directoryCount) +
                " images=" + std::to_string(imageCount) +
                " junk=" + std::to_string(junkCount) +
                " nonImage=" + std::to_string(nonImageCount) +
                " readStatus=" + std::to_string(readStatus) +
                " sampleAccepted=" + archiveDebugJoinSamples(acceptedSamples) +
                " sampleRejected=" + archiveDebugJoinSamples(rejectedSamples)
            );
        });

        return sortEntries(std::move(entries));
    }

    int processEntries(const std::string& archivePath,
                       const std::vector<CanonicalArchiveEntry>& entries,
                       const EntryProcessor& processor,
                       const WarningCb& warningCb,
                       ProgressCb progressCb,
                       void* userData) override {
        AssignmentMap assignments = buildAssignmentMap(entries);
        auto* cancelContext = reinterpret_cast<ArchiveCancelContext*>(userData);
        cancelFlag = cancelContext ? cancelContext->flag : nullptr;
        int processedCount = 0;
        int unmatchedImageCount = 0;
        int skippedNonImageCount = 0;
        int failedExtractionCount = 0;
        std::vector<std::string> unmatchedSamples;
        std::vector<std::string> skippedNonImageSamples;
        std::vector<std::string> failedExtractionSamples;

        archiveDebugLog(
            std::string("RAR processEntries start archive=\"") + archivePath +
            "\" requestedEntries=" + std::to_string(entries.size()) +
            " assignmentKeys=" + std::to_string(assignments.size())
        );

        try {
            openArchive(archivePath, [&](HANDLE hArc) {
                RARHeaderDataEx header{};
                int readStatus = 0;
                while (!isCancelled() && (readStatus = RARReadHeaderEx(hArc, &header)) == 0) {
                    std::string name = rarEntryNameUtf8(header);
                    const bool isDir = (header.Flags & RHDF_DIRECTORY) != 0;
                    if (isDir) {
                        const int skipResult = RARProcessFile(hArc, RAR_SKIP, nullptr, nullptr);
                        if (skipResult != 0) {
                            archiveDebugLog(
                                std::string("RAR processEntries skip_directory_failure archive=\"") + archivePath +
                                "\" entry=\"" + name + "\" result=" + std::to_string(skipResult)
                            );
                            throw std::runtime_error("Failed to skip RAR entry: " + name + " (result=" + std::to_string(skipResult) + ")");
                        }
                        continue;
                    }

                    if (!isImageArchiveEntry(name)) {
                        skippedNonImageCount++;
                        if (skippedNonImageSamples.size() < 5) {
                            skippedNonImageSamples.push_back(name);
                        }
                        const int skipResult = RARProcessFile(hArc, RAR_SKIP, nullptr, nullptr);
                        if (skipResult != 0) {
                            archiveDebugLog(
                                std::string("RAR processEntries skip_non_image_failure archive=\"") + archivePath +
                                "\" entry=\"" + name + "\" result=" + std::to_string(skipResult)
                            );
                            throw std::runtime_error("Failed to skip RAR entry: " + name + " (result=" + std::to_string(skipResult) + ")");
                        }
                        continue;
                    }

                    auto assignmentIt = assignments.find(name);
                    if (assignmentIt == assignments.end() || assignmentIt->second.empty()) {
                        unmatchedImageCount++;
                        if (unmatchedSamples.size() < 5) {
                            unmatchedSamples.push_back(name);
                        }
                        const int skipResult = RARProcessFile(hArc, RAR_SKIP, nullptr, nullptr);
                        if (skipResult != 0) {
                            archiveDebugLog(
                                std::string("RAR processEntries skip_unmatched_failure archive=\"") + archivePath +
                                "\" entry=\"" + name + "\" result=" + std::to_string(skipResult)
                            );
                            throw std::runtime_error("Failed to skip unmatched RAR entry: " + name + " (result=" + std::to_string(skipResult) + ")");
                        }
                        continue;
                    }

                    SortedAssignment assignment = assignmentIt->second.front();
                    assignmentIt->second.pop_front();

                    currentEntryData.clear();
                    lastWriteOk = true;
                    const int result = RARProcessFile(hArc, RAR_TEST, nullptr, nullptr);

                    if (isCancelled()) {
                        break;
                    }

                    if (result != 0 || !lastWriteOk) {
                        const std::uint64_t unpackedSize = combineRarSize(header.UnpSize, header.UnpSizeHigh);
                        const std::uint64_t packedSize = combineRarSize(header.PackSize, header.PackSizeHigh);
                        failedExtractionCount++;
                        if (failedExtractionSamples.size() < 5) {
                            failedExtractionSamples.push_back(name);
                        }
                        archiveDebugLog(
                            std::string("RAR processEntries extract_failure_tolerated archive=\"") + archivePath +
                            "\" entry=\"" + name + "\" result=" + std::to_string(result) +
                            " lastWriteOk=" + (lastWriteOk ? "true" : "false") +
                            " capturedBytes=" + std::to_string(currentEntryData.size()) +
                            " unpackedSize=" + std::to_string(unpackedSize) +
                            " packedSize=" + std::to_string(packedSize) +
                            " method=" + std::to_string(header.Method) +
                            " flags=" + std::to_string(header.Flags)
                        );
                        const std::string message =
                            "Failed to extract RAR entry: " + name +
                            " (result=" + std::to_string(result) +
                            ", lastWriteOk=" + std::string(lastWriteOk ? "true" : "false") +
                            ", capturedBytes=" + std::to_string(currentEntryData.size()) +
                            ", unpackedSize=" + std::to_string(unpackedSize) +
                            ", packedSize=" + std::to_string(packedSize) +
                            ")";
                        std::cerr
                            << "Skipped RAR entry due to extraction failure: " << name
                            << " (result=" << result
                            << ", lastWriteOk=" << (lastWriteOk ? "true" : "false")
                            << ", capturedBytes=" << currentEntryData.size()
                            << ", unpackedSize=" << unpackedSize
                            << ", packedSize=" << packedSize
                            << ")" << std::endl;
                        if (warningCb) {
                            warningCb(assignment.sortedIndex, assignment.entry, message);
                        }
                        currentEntryData.clear();
                        continue;
                    }

                    processor(assignment.sortedIndex, assignment.entry, std::move(currentEntryData));
                    currentEntryData.clear();

                    if (progressCb) {
                        progressCb(assignment.sortedIndex, static_cast<int>(entries.size()), assignment.entry.archivePath, userData);
                    }
                    processedCount++;
                }
                archiveDebugLog(
                    std::string("RAR processEntries summary archive=\"") + archivePath +
                    "\" requestedEntries=" + std::to_string(entries.size()) +
                    " processed=" + std::to_string(processedCount) +
                    " unmatchedImages=" + std::to_string(unmatchedImageCount) +
                    " skippedNonImage=" + std::to_string(skippedNonImageCount) +
                    " failedExtractions=" + std::to_string(failedExtractionCount) +
                    " readStatus=" + std::to_string(readStatus) +
                    " sampleUnmatched=" + archiveDebugJoinSamples(unmatchedSamples) +
                    " sampleSkipped=" + archiveDebugJoinSamples(skippedNonImageSamples) +
                    " sampleFailedExtractions=" + archiveDebugJoinSamples(failedExtractionSamples)
                );
            });
        } catch (...) {
            cancelFlag = nullptr;
            currentEntryData.clear();
            throw;
        }

        cancelFlag = nullptr;
        currentEntryData.clear();
        return processedCount;
    }

    void close() override {
        currentEntryData.clear();
        cancelFlag = nullptr;
        lastWriteOk = true;
    }

private:
    template <typename Fn>
    void openArchive(const std::string& archivePath, Fn&& fn) {
        RAROpenArchiveDataEx arcData{};
        arcData.ArcName = const_cast<char*>(archivePath.c_str());
        arcData.OpenMode = RAR_OM_EXTRACT;

        HANDLE hArc = RAROpenArchiveEx(&arcData);
        if (!hArc || arcData.OpenResult != 0) {
            throw std::runtime_error("Failed to open RAR archive: " + archivePath);
        }

        RARSetCallback(hArc, extractCallback, reinterpret_cast<LPARAM>(this));
        try {
            fn(hArc);
            RARCloseArchive(hArc);
        } catch (...) {
            RARCloseArchive(hArc);
            throw;
        }
    }

    bool isCancelled() const {
        return cancelFlag && *cancelFlag != 0;
    }

    static int CALLBACK extractCallback(UINT msg, LPARAM userData, LPARAM p1, LPARAM p2) {
        if (msg != UCM_PROCESSDATA) return 1;

        auto* self = reinterpret_cast<RarBackend*>(userData);
        if (self->isCancelled()) {
            self->lastWriteOk = false;
            return -1;
        }

        if (!p1 || p2 < 0) {
            self->lastWriteOk = false;
            archiveDebugLog("RAR extractCallback invalid chunk received");
            return -1;
        }

        const auto* chunk = reinterpret_cast<const unsigned char*>(p1);
        self->currentEntryData.insert(self->currentEntryData.end(), chunk, chunk + p2);
        return 1;
    }

    volatile sig_atomic_t* cancelFlag = nullptr;
    std::vector<uint8_t> currentEntryData;
    bool lastWriteOk = true;
};

std::unique_ptr<ArchiveBackend> createRarBackend() {
    return std::make_unique<RarBackend>();
}

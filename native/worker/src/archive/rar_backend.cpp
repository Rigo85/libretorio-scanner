#include "archive_backend.h"
#include "archive_entry_utils.h"
#include "unrar_compat.h"

#include <codecvt>
#include <deque>
#include <locale>
#include <memory>
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

ArchiveProbeResult finalizeProbeResult(const ArchiveProbeResult& partial, int minImages) {
    ArchiveProbeResult result = partial;
    if (result.accepted) {
        result.reason = "accepted";
        return result;
    }

    result.reason = result.imageCount <= 0 ? "no_images" : "below_min_images";
    if (result.entriesScanned < 1 && result.reason == "no_images") {
        result.reason = "no_entries";
    }
    if (result.imageCount >= minImages) {
        result.accepted = true;
        result.reason = "accepted";
    }
    return result;
}

}  // namespace

class RarBackend : public ArchiveBackend {
public:
    std::vector<CanonicalArchiveEntry> listEntries(const std::string& archivePath) override {
        std::vector<CanonicalArchiveEntry> entries;
        openArchive(archivePath, [&](HANDLE hArc) {
            RARHeaderDataEx header{};
            while (RARReadHeaderEx(hArc, &header) == 0) {
                std::string name = rarEntryNameUtf8(header);
                const bool isDir = (header.Flags & RHDF_DIRECTORY) != 0;
                if (!isDir && isImageArchiveEntry(name)) {
                    std::string extension = archiveExtension(name);
                    if (extension.empty()) {
                        extension = ".bin";
                    }
                    entries.push_back({name, name, extension});
                }
                RARProcessFile(hArc, RAR_SKIP, nullptr, nullptr);
            }
        });

        return sortEntries(std::move(entries));
    }

    int processEntries(const std::string& archivePath,
                       const std::vector<CanonicalArchiveEntry>& entries,
                       const EntryProcessor& processor,
                       ProgressCb progressCb,
                       void* userData) override {
        AssignmentMap assignments = buildAssignmentMap(entries);
        auto* cancelContext = reinterpret_cast<ArchiveCancelContext*>(userData);
        cancelFlag = cancelContext ? cancelContext->flag : nullptr;
        int processedCount = 0;

        try {
            openArchive(archivePath, [&](HANDLE hArc) {
                RARHeaderDataEx header{};
                while (!isCancelled() && RARReadHeaderEx(hArc, &header) == 0) {
                    std::string name = rarEntryNameUtf8(header);
                    const bool isDir = (header.Flags & RHDF_DIRECTORY) != 0;
                    if (isDir || !isImageArchiveEntry(name)) {
                        RARProcessFile(hArc, RAR_SKIP, nullptr, nullptr);
                        continue;
                    }

                    auto assignmentIt = assignments.find(name);
                    if (assignmentIt == assignments.end() || assignmentIt->second.empty()) {
                        RARProcessFile(hArc, RAR_SKIP, nullptr, nullptr);
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
                        throw std::runtime_error("Failed to extract RAR entry: " + name);
                    }

                    processor(assignment.sortedIndex, assignment.entry, std::move(currentEntryData));
                    currentEntryData.clear();

                    if (progressCb) {
                        progressCb(assignment.sortedIndex, static_cast<int>(entries.size()), assignment.entry.archivePath, userData);
                    }
                    processedCount++;
                }
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

    ArchiveProbeResult probeEntries(const std::string& archivePath, int maxEntries, int minImages) override {
        ArchiveProbeResult result;

        openArchive(archivePath, [&](HANDLE hArc) {
            RARHeaderDataEx header{};
            while (RARReadHeaderEx(hArc, &header) == 0) {
                std::string name = rarEntryNameUtf8(header);
                const bool isDir = (header.Flags & RHDF_DIRECTORY) != 0;
                if (isDir || isJunkArchiveEntry(name)) {
                    RARProcessFile(hArc, RAR_SKIP, nullptr, nullptr);
                    continue;
                }

                result.entriesScanned++;
                if (isImageArchiveEntry(name)) {
                    result.imageCount++;
                    if (result.imageCount >= minImages) {
                        result.accepted = true;
                        RARProcessFile(hArc, RAR_SKIP, nullptr, nullptr);
                        break;
                    }
                }

                RARProcessFile(hArc, RAR_SKIP, nullptr, nullptr);
                if (result.entriesScanned >= maxEntries) {
                    break;
                }
            }
        });

        return finalizeProbeResult(result, minImages);
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

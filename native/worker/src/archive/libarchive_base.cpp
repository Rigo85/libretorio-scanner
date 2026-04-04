#include "libarchive_base.h"

#include <algorithm>
#include <csignal>
#include <deque>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

bool isCancelled(void* userData) {
    auto* ctx = reinterpret_cast<ArchiveCancelContext*>(userData);
    return ctx && ctx->flag && *ctx->flag != 0;
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

std::vector<uint8_t> readArchiveEntryData(archive* arc, const std::string& entryName) {
    std::vector<uint8_t> output;
    char chunk[64 * 1024];

    while (true) {
        const la_ssize_t bytesRead = archive_read_data(arc, chunk, sizeof(chunk));
        if (bytesRead == 0) {
            break;
        }
        if (bytesRead < 0) {
            const char* archiveMessage = archive_error_string(arc);
            throw std::runtime_error(
                "Failed to read archive entry data: " + entryName +
                (archiveMessage ? " (" + std::string(archiveMessage) + ")" : "")
            );
        }

        output.insert(output.end(), chunk, chunk + bytesRead);
    }

    return output;
}

}  // namespace

archive* LibarchiveBackend::openArchive(const std::string& archivePath) const {
    archive* arc = archive_read_new();
    if (!arc) {
        throw std::runtime_error(std::string("Failed to allocate libarchive reader for ") + formatLabel());
    }

    archive_read_support_filter_all(arc);
    configureFormat(arc);

    if (archive_read_open_filename(arc, archivePath.c_str(), 10240) != ARCHIVE_OK) {
        std::string message = archive_error_string(arc) ? archive_error_string(arc) : "unknown error";
        archive_read_free(arc);
        throw std::runtime_error(std::string("Failed to open ") + formatLabel() + " archive: " + message);
    }

    return arc;
}

std::vector<CanonicalArchiveEntry> LibarchiveBackend::listEntries(const std::string& archivePath) {
    std::vector<CanonicalArchiveEntry> entries;
    archive* arc = openArchive(archivePath);
    archive_entry* entry = nullptr;

    while (true) {
        const int headerStatus = archive_read_next_header(arc, &entry);
        if (headerStatus == ARCHIVE_EOF) break;
        if (headerStatus == ARCHIVE_RETRY) continue;
        if (headerStatus != ARCHIVE_OK && headerStatus != ARCHIVE_WARN) break;

        const std::string name = archiveEntryPathUtf8(entry);
        const bool isDir = archive_entry_filetype(entry) == AE_IFDIR;

        if (isDir || !isImageArchiveEntry(name)) {
            archive_read_data_skip(arc);
            continue;
        }

        std::string extension = archiveExtension(name);
        if (extension.empty()) {
            extension = ".bin";
        }

        entries.push_back({name, name, extension});
        archive_read_data_skip(arc);
    }

    archive_read_close(arc);
    archive_read_free(arc);

    return sortEntries(std::move(entries));
}

int LibarchiveBackend::processEntries(const std::string& archivePath,
                                      const std::vector<CanonicalArchiveEntry>& entries,
                                      const EntryProcessor& processor,
                                      ProgressCb progressCb,
                                      void* userData) {
    archive* arc = openArchive(archivePath);
    archive_entry* entry = nullptr;
    AssignmentMap assignments = buildAssignmentMap(entries);
    int processedCount = 0;

    try {
        while (true) {
            const int headerStatus = archive_read_next_header(arc, &entry);
            if (headerStatus == ARCHIVE_EOF) break;
            if (headerStatus == ARCHIVE_RETRY) continue;
            if (headerStatus != ARCHIVE_OK && headerStatus != ARCHIVE_WARN) break;

            if (isCancelled(userData)) {
                break;
            }

            const std::string name = archiveEntryPathUtf8(entry);
            const bool isDir = archive_entry_filetype(entry) == AE_IFDIR;

            if (isDir || !isImageArchiveEntry(name)) {
                archive_read_data_skip(arc);
                continue;
            }

            auto assignmentIt = assignments.find(name);
            if (assignmentIt == assignments.end() || assignmentIt->second.empty()) {
                archive_read_data_skip(arc);
                continue;
            }

            SortedAssignment assignment = assignmentIt->second.front();
            assignmentIt->second.pop_front();

            std::vector<uint8_t> data = readArchiveEntryData(arc, assignment.entry.archivePath);
            processor(assignment.sortedIndex, assignment.entry, std::move(data));

            if (progressCb) {
                progressCb(assignment.sortedIndex, static_cast<int>(entries.size()), assignment.entry.archivePath, userData);
            }
            processedCount++;
        }
    } catch (...) {
        archive_read_close(arc);
        archive_read_free(arc);
        throw;
    }

    archive_read_close(arc);
    archive_read_free(arc);
    return processedCount;
}

void LibarchiveBackend::close() {
}

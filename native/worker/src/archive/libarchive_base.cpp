#include "libarchive_base.h"

#include <algorithm>
#include <csignal>
#include <deque>
#include <iostream>
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
    std::vector<std::string> acceptedSamples;
    std::vector<std::string> rejectedSamples;
    int headerCount = 0;
    int directoryCount = 0;
    int imageCount = 0;
    int junkCount = 0;
    int nonImageCount = 0;
    int emptyNameCount = 0;
    archive* arc = openArchive(archivePath);
    archive_entry* entry = nullptr;

    while (true) {
        const int headerStatus = archive_read_next_header(arc, &entry);
        if (headerStatus == ARCHIVE_EOF) break;
        if (headerStatus == ARCHIVE_RETRY) continue;
        if (headerStatus != ARCHIVE_OK && headerStatus != ARCHIVE_WARN) {
            archiveDebugLog(
                std::string(formatLabel()) + " listEntries header_status archive=\"" + archivePath +
                "\" status=" + std::to_string(headerStatus)
            );
            break;
        }

        headerCount++;
        const std::string name = archiveEntryPathUtf8(entry);
        const bool isDir = archive_entry_filetype(entry) == AE_IFDIR;
        const std::string entryDebug = archiveDebugEnabled() ? describeArchiveEntryPath(entry) : "";

        if (archiveDebugEnabled() && headerCount <= 5) {
            archiveDebugLog(
                std::string(formatLabel()) + " listEntries header#" + std::to_string(headerCount) +
                " path=" + entryDebug +
                " size=" + std::to_string(archive_entry_size(entry))
            );
        }

        if (isDir) {
            directoryCount++;
            archive_read_data_skip(arc);
            continue;
        }

        if (name.empty()) {
            emptyNameCount++;
            if (rejectedSamples.size() < 5) {
                rejectedSamples.push_back("<empty-name>");
            }
            archiveDebugLog(
                std::string(formatLabel()) + " listEntries empty_name archive=\"" + archivePath +
                "\" header=" + std::to_string(headerCount) +
                " path=" + entryDebug
            );
            archive_read_data_skip(arc);
            continue;
        }

        if (isJunkArchiveEntry(name)) {
            junkCount++;
            if (rejectedSamples.size() < 5) {
                rejectedSamples.push_back(name + " [junk]");
            }
            archive_read_data_skip(arc);
            continue;
        }

        if (!isImageArchiveEntry(name)) {
            nonImageCount++;
            if (rejectedSamples.size() < 5) {
                rejectedSamples.push_back(name + " [ext=" + archiveExtension(name) + "]");
            }
            archive_read_data_skip(arc);
            continue;
        }

        std::string extension = archiveExtension(name);
        if (extension.empty()) {
            extension = ".bin";
        }

        entries.push_back({name, name, extension});
        imageCount++;
        if (acceptedSamples.size() < 5) {
            acceptedSamples.push_back(name);
        }
        archive_read_data_skip(arc);
    }

    archive_read_close(arc);
    archive_read_free(arc);

    archiveDebugLog(
        std::string(formatLabel()) + " listEntries summary archive=\"" + archivePath +
        "\" headers=" + std::to_string(headerCount) +
        " directories=" + std::to_string(directoryCount) +
        " images=" + std::to_string(imageCount) +
        " junk=" + std::to_string(junkCount) +
        " emptyName=" + std::to_string(emptyNameCount) +
        " nonImage=" + std::to_string(nonImageCount) +
        " sampleAccepted=" + archiveDebugJoinSamples(acceptedSamples) +
        " sampleRejected=" + archiveDebugJoinSamples(rejectedSamples)
    );

    return sortEntries(std::move(entries));
}

int LibarchiveBackend::processEntries(const std::string& archivePath,
                                      const std::vector<CanonicalArchiveEntry>& entries,
                                      const EntryProcessor& processor,
                                      const WarningCb& warningCb,
                                      ProgressCb progressCb,
                                      void* userData) {
    archive* arc = openArchive(archivePath);
    archive_entry* entry = nullptr;
    AssignmentMap assignments = buildAssignmentMap(entries);
    int processedCount = 0;
    int unmatchedImageCount = 0;
    int skippedNonImageCount = 0;
    std::vector<std::string> unmatchedSamples;
    std::vector<std::string> skippedNonImageSamples;

    archiveDebugLog(
        std::string(formatLabel()) + " processEntries start archive=\"" + archivePath +
        "\" requestedEntries=" + std::to_string(entries.size()) +
        " assignmentKeys=" + std::to_string(assignments.size())
    );

    try {
        while (true) {
            const int headerStatus = archive_read_next_header(arc, &entry);
            if (headerStatus == ARCHIVE_EOF) break;
            if (headerStatus == ARCHIVE_RETRY) continue;
            if (headerStatus != ARCHIVE_OK && headerStatus != ARCHIVE_WARN) {
                archiveDebugLog(
                    std::string(formatLabel()) + " processEntries header_status archive=\"" + archivePath +
                    "\" status=" + std::to_string(headerStatus) +
                    " processed=" + std::to_string(processedCount)
                );
                break;
            }

            if (isCancelled(userData)) {
                break;
            }

            const std::string name = archiveEntryPathUtf8(entry);
            const bool isDir = archive_entry_filetype(entry) == AE_IFDIR;
            const std::string entryDebug = archiveDebugEnabled() ? describeArchiveEntryPath(entry) : "";

            if (archiveDebugEnabled() && processedCount == 0 && (unmatchedImageCount + skippedNonImageCount) < 5) {
                archiveDebugLog(
                    std::string(formatLabel()) + " processEntries visiting path=" + entryDebug +
                    " size=" + std::to_string(archive_entry_size(entry))
                );
            }

            if (isDir) {
                archive_read_data_skip(arc);
                continue;
            }

            if (name.empty()) {
                archiveDebugLog(
                    std::string(formatLabel()) + " processEntries empty_name archive=\"" + archivePath +
                    "\" path=" + entryDebug
                );
                archive_read_data_skip(arc);
                continue;
            }

            if (!isImageArchiveEntry(name)) {
                skippedNonImageCount++;
                if (skippedNonImageSamples.size() < 5) {
                    skippedNonImageSamples.push_back(name + " path=" + entryDebug);
                }
                archive_read_data_skip(arc);
                continue;
            }

            auto assignmentIt = assignments.find(name);
            if (assignmentIt == assignments.end() || assignmentIt->second.empty()) {
                unmatchedImageCount++;
                if (unmatchedSamples.size() < 5) {
                    unmatchedSamples.push_back(name + " path=" + entryDebug);
                }
                archive_read_data_skip(arc);
                continue;
            }

            SortedAssignment assignment = assignmentIt->second.front();
            assignmentIt->second.pop_front();

            try {
                std::vector<uint8_t> data = readArchiveEntryData(arc, assignment.entry.archivePath);
                processor(assignment.sortedIndex, assignment.entry, std::move(data));
            } catch (const std::exception& error) {
                const std::string message = error.what();
                archiveDebugLog(
                    std::string(formatLabel()) + " processEntries tolerated_read_failure archive=\"" + archivePath +
                    "\" entry=\"" + assignment.entry.archivePath + "\" message=\"" + message + "\""
                );
                std::cerr
                    << "Skipped archive entry due to read failure: "
                    << assignment.entry.archivePath
                    << " (" << message << ")"
                    << std::endl;
                if (warningCb) {
                    warningCb(assignment.sortedIndex, assignment.entry, message);
                }
                continue;
            }

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
    archiveDebugLog(
        std::string(formatLabel()) + " processEntries summary archive=\"" + archivePath +
        "\" requestedEntries=" + std::to_string(entries.size()) +
        " processed=" + std::to_string(processedCount) +
        " unmatchedImages=" + std::to_string(unmatchedImageCount) +
        " skippedNonImage=" + std::to_string(skippedNonImageCount) +
        " sampleUnmatched=" + archiveDebugJoinSamples(unmatchedSamples) +
        " sampleSkipped=" + archiveDebugJoinSamples(skippedNonImageSamples)
    );
    return processedCount;
}

void LibarchiveBackend::close() {
}

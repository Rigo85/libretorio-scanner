#pragma once

#include "archive_entry_utils.h"

#include <csignal>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

struct ArchiveCancelContext {
    volatile sig_atomic_t* flag = nullptr;
};

struct ArchiveProbeResult {
    bool accepted = false;
    int entriesScanned = 0;
    int imageCount = 0;
    std::string reason;
};

/**
 * Abstract interface for archive backends.
 *
 * Two-phase approach:
 * 1. listEntries() — list and naturally sort image entries.
 * 2. processEntries() — single sequential extraction pass that yields entry bytes
 *    in sorted-index order to the caller for final processing/output.
 */
class ArchiveBackend {
public:
    virtual ~ArchiveBackend() = default;

    /// List and naturally sort image entries from the archive.
    virtual std::vector<CanonicalArchiveEntry> listEntries(const std::string& archivePath) = 0;

    /// Process all image entries from the archive in a single sequential pass.
    /// The processor receives the final sorted index, entry descriptor, and raw entry bytes.
    using EntryProcessor = std::function<void(int sortedIndex, const CanonicalArchiveEntry&, std::vector<uint8_t>&&)>;

    /// progressCb is called after each entry: (currentIndex, totalEstimate, entryName)
    using ProgressCb = void(*)(int current, int total, const std::string& name, void* userData);
    virtual int processEntries(const std::string& archivePath,
                               const std::vector<CanonicalArchiveEntry>& entries,
                               const EntryProcessor& processor,
                               ProgressCb progressCb = nullptr,
                               void* userData = nullptr) = 0;

    virtual ArchiveProbeResult probeEntries(const std::string& archivePath,
                                            int maxEntries,
                                            int minImages) = 0;

    /// Close and free resources.
    virtual void close() = 0;
};

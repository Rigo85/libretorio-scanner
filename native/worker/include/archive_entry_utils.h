#pragma once

#include <archive_entry.h>

#include <cstddef>
#include <string>
#include <vector>

struct CanonicalArchiveEntry {
    std::string archivePath;
    std::string sortKey;
    std::string extension;
};

std::string archiveEntryPathUtf8(archive_entry* entry);
std::string normalizeArchivePath(std::string path);
std::string archiveBasename(const std::string& path);
std::string archiveExtension(const std::string& path);
bool isJunkArchiveEntry(const std::string& path);
bool isImageArchiveEntry(const std::string& path);
bool naturalArchivePathLess(const std::string& lhs, const std::string& rhs);
std::vector<CanonicalArchiveEntry> sortEntries(std::vector<CanonicalArchiveEntry>&& input);

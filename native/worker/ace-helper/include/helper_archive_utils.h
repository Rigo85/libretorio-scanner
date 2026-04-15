#pragma once

#include <string>

std::string normalizeArchivePath(std::string path);
std::string archiveBasename(const std::string& path);
std::string archiveExtension(const std::string& path);
bool isJunkArchiveEntry(const std::string& path);
bool isImageArchiveEntry(const std::string& path);
bool naturalArchivePathLess(const std::string& lhs, const std::string& rhs);

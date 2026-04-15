#include "helper_archive_utils.h"

#include <algorithm>
#include <cctype>
#include <set>
#include <string>

static const std::set<std::string> IMAGE_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp", ".tiff", ".tif"
};

namespace {

char toLowerAscii(char c) {
    const unsigned char uc = static_cast<unsigned char>(c);
    if (uc >= 'A' && uc <= 'Z') {
        return static_cast<char>(uc - 'A' + 'a');
    }
    return c;
}

std::size_t skipLeadingZeros(const std::string& value, std::size_t start, std::size_t end) {
    std::size_t pos = start;
    while (pos < end && value[pos] == '0') {
        pos++;
    }
    return pos;
}

int compareDigitRuns(const std::string& lhs, std::size_t& i, const std::string& rhs, std::size_t& j) {
    const std::size_t lhsStart = i;
    const std::size_t rhsStart = j;

    while (i < lhs.size() && std::isdigit(static_cast<unsigned char>(lhs[i]))) i++;
    while (j < rhs.size() && std::isdigit(static_cast<unsigned char>(rhs[j]))) j++;

    const std::size_t lhsTrimmed = skipLeadingZeros(lhs, lhsStart, i);
    const std::size_t rhsTrimmed = skipLeadingZeros(rhs, rhsStart, j);
    const std::size_t lhsDigits = i - lhsTrimmed;
    const std::size_t rhsDigits = j - rhsTrimmed;

    if (lhsDigits != rhsDigits) {
        return lhsDigits < rhsDigits ? -1 : 1;
    }

    for (std::size_t offset = 0; offset < lhsDigits; offset++) {
        const char a = lhs[lhsTrimmed + offset];
        const char b = rhs[rhsTrimmed + offset];
        if (a != b) {
            return a < b ? -1 : 1;
        }
    }

    const std::size_t lhsRunLen = i - lhsStart;
    const std::size_t rhsRunLen = j - rhsStart;
    if (lhsRunLen != rhsRunLen) {
        return lhsRunLen < rhsRunLen ? -1 : 1;
    }

    return 0;
}

}  // namespace

std::string normalizeArchivePath(std::string path) {
    std::replace(path.begin(), path.end(), '\\', '/');

    std::string normalized;
    normalized.reserve(path.size());

    bool previousWasSlash = false;
    for (char c : path) {
        if (c == '/') {
            if (!previousWasSlash) {
                normalized.push_back(c);
            }
            previousWasSlash = true;
            continue;
        }
        previousWasSlash = false;
        normalized.push_back(c);
    }

    while (normalized.rfind("./", 0) == 0) {
        normalized.erase(0, 2);
    }
    while (!normalized.empty() && normalized.front() == '/') {
        normalized.erase(normalized.begin());
    }
    while (!normalized.empty() && normalized.back() == '/') {
        normalized.pop_back();
    }

    std::transform(normalized.begin(), normalized.end(), normalized.begin(), toLowerAscii);
    return normalized;
}

std::string archiveBasename(const std::string& path) {
    const auto pos = path.find_last_of("/\\");
    return (pos == std::string::npos) ? path : path.substr(pos + 1);
}

std::string archiveExtension(const std::string& path) {
    const auto base = archiveBasename(path);
    const auto pos = base.rfind('.');
    if (pos == std::string::npos) return "";

    std::string ext = base.substr(pos);
    std::transform(ext.begin(), ext.end(), ext.begin(), toLowerAscii);
    return ext;
}

bool isJunkArchiveEntry(const std::string& path) {
    const std::string normalized = normalizeArchivePath(path);
    const std::string base = archiveBasename(normalized);
    if (base.rfind("._", 0) == 0) return true;
    if (normalized.find("__macosx/") != std::string::npos) return true;
    if (base == "thumbs.db" || base == "desktop.ini") return true;
    if (!base.empty() && base[0] == '.') return true;
    return false;
}

bool isImageArchiveEntry(const std::string& path) {
    const std::string normalized = normalizeArchivePath(path);
    if (isJunkArchiveEntry(normalized)) return false;
    return IMAGE_EXTENSIONS.count(archiveExtension(normalized)) > 0;
}

bool naturalArchivePathLess(const std::string& lhs, const std::string& rhs) {
    std::size_t i = 0;
    std::size_t j = 0;

    while (i < lhs.size() && j < rhs.size()) {
        const unsigned char a = static_cast<unsigned char>(lhs[i]);
        const unsigned char b = static_cast<unsigned char>(rhs[j]);

        if (std::isdigit(a) && std::isdigit(b)) {
            const std::size_t lhsBefore = i;
            const std::size_t rhsBefore = j;
            const int digitCompare = compareDigitRuns(lhs, i, rhs, j);
            if (digitCompare != 0) {
                return digitCompare < 0;
            }
            if (lhsBefore != i || rhsBefore != j) {
                continue;
            }
        }

        if (lhs[i] != rhs[j]) {
            return lhs[i] < rhs[j];
        }
        i++;
        j++;
    }

    return lhs.size() < rhs.size();
}

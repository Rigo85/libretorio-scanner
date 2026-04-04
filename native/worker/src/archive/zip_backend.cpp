#include "libarchive_base.h"
#include <memory>

class ZipBackend : public LibarchiveBackend {
protected:
    void configureFormat(archive* arc) const override {
        archive_read_support_format_zip(arc);
    }
    const char* formatLabel() const override { return "ZIP"; }
};

std::unique_ptr<ArchiveBackend> createZipBackend() {
    return std::make_unique<ZipBackend>();
}

#include "libarchive_base.h"
#include <memory>

class TarBackend : public LibarchiveBackend {
protected:
    void configureFormat(archive* arc) const override {
        archive_read_support_format_tar(arc);
        archive_read_support_format_raw(arc);  // handles .tar.gz, .tar.bz2 etc.
    }
    const char* formatLabel() const override { return "TAR"; }
};

std::unique_ptr<ArchiveBackend> createTarBackend() {
    return std::make_unique<TarBackend>();
}

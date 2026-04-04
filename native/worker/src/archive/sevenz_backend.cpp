#include "libarchive_base.h"

#include <memory>

class SevenZBackend : public LibarchiveBackend {
protected:
	void configureFormat(archive* arc) const override {
		archive_read_support_format_7zip(arc);
	}

	const char* formatLabel() const override {
		return "7Z";
	}
};

std::unique_ptr<ArchiveBackend> createSevenZBackend() {
	return std::make_unique<SevenZBackend>();
}

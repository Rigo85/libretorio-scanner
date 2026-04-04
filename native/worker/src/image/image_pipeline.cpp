#include "image_pipeline.h"

#include <vips/vips.h>

#include <algorithm>
#include <cctype>
#include <fstream>
#include <string>

namespace {

std::string getExtension(const std::string& filename) {
    const auto pos = filename.rfind('.');
    if (pos == std::string::npos) return "";

    std::string ext = filename.substr(pos);
    std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char value) {
        return static_cast<char>(std::tolower(value));
    });
    return ext;
}

std::string getEncodedExtension(const ImageConfig& config) {
    return config.readerFormat == "webp" ? ".webp" : ".jpg";
}

std::string resolveOutputExtension(const std::string& name, const ImageConfig& config, bool bypassed) {
    if (bypassed) {
        const std::string originalExt = getExtension(name);
        if (!originalExt.empty()) {
            return originalExt;
        }
    }

    return getEncodedExtension(config);
}

bool writeRawBytes(const std::vector<uint8_t>& data, const std::string& outputPath, std::string& errorMessage) {
    std::ofstream out(outputPath, std::ios::binary | std::ios::trunc);
    if (!out) {
        errorMessage = "Failed to write page file: " + outputPath;
        return false;
    }

    out.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
    out.close();
    return out.good();
}

}  // namespace

ImageResult processImage(
    const std::vector<uint8_t>& data,
    const std::string& name,
    const ImageConfig& config,
    const std::string& outputStem
) {
    ImageResult result;

    const char* loader = vips_foreign_find_load_buffer(data.data(), data.size());
    if (!loader) {
        result.errorMessage = "Failed to detect image format: " + std::string(vips_error_buffer());
        vips_error_clear();
        return result;
    }

    VipsImage* header = vips_image_new_from_buffer(
        data.data(),
        data.size(),
        "",
        "access", VIPS_ACCESS_SEQUENTIAL,
        nullptr
    );
    if (!header) {
        result.errorMessage = "Failed to read image header: " + std::string(vips_error_buffer());
        vips_error_clear();
        return result;
    }

    result.originalWidth = vips_image_get_width(header);
    result.originalHeight = vips_image_get_height(header);
    g_object_unref(header);

    const int maxDim = std::max(result.originalWidth, result.originalHeight);
    result.bypassed = maxDim <= config.readerMaxDimension;
    result.outputExtension = resolveOutputExtension(name, config, result.bypassed);

    const std::string outputPath = outputStem + result.outputExtension;

    if (result.bypassed) {
        if (!writeRawBytes(data, outputPath, result.errorMessage)) {
            return result;
        }

        result.outputWidth = result.originalWidth;
        result.outputHeight = result.originalHeight;
        result.ok = true;
        return result;
    }

    VipsImage* page = nullptr;
    if (vips_thumbnail_buffer(
            const_cast<void*>(static_cast<const void*>(data.data())),
            data.size(),
            &page,
            config.readerMaxDimension,
            "height", config.readerMaxDimension,
            "size", VIPS_SIZE_DOWN,
            nullptr
        ) != 0) {
        result.errorMessage = "Failed to resize page: " + std::string(vips_error_buffer());
        vips_error_clear();
        return result;
    }

    int saveStatus = 0;
    if (config.readerFormat == "webp") {
        saveStatus = vips_webpsave(
            page,
            outputPath.c_str(),
            "Q", config.readerQuality,
            "effort", 1,
            "strip", TRUE,
            nullptr
        );
    } else {
        saveStatus = vips_jpegsave(
            page,
            outputPath.c_str(),
            "Q", config.readerQuality,
            "strip", TRUE,
            nullptr
        );
    }

    if (saveStatus != 0) {
        g_object_unref(page);
        result.errorMessage = "Failed to save page: " + std::string(vips_error_buffer());
        vips_error_clear();
        return result;
    }

    result.outputWidth = vips_image_get_width(page);
    result.outputHeight = vips_image_get_height(page);
    g_object_unref(page);
    result.ok = true;
    return result;
}

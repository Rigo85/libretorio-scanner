#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct ImageConfig {
    int readerMaxDimension = 2400;
    int readerQuality = 82;
    int vipsConcurrency = 1;
    std::string readerFormat = "jpeg";
};

struct ImageResult {
    bool ok = false;
    std::string errorMessage;
    std::string outputExtension;

    int originalWidth = 0;
    int originalHeight = 0;
    int outputWidth = 0;
    int outputHeight = 0;
    bool bypassed = false;
};

ImageResult processImage(
    const std::vector<uint8_t>& data,
    const std::string& name,
    const ImageConfig& config,
    const std::string& outputStem
);

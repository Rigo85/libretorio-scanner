cmake_minimum_required(VERSION 3.16)
project(comic-cache-worker LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(ARCHIVE REQUIRED IMPORTED_TARGET libarchive)
pkg_check_modules(VIPS REQUIRED IMPORTED_TARGET vips)
find_library(UNRAR_LIB unrar REQUIRED)

set(SEVEN_Z_SDK_SOURCES
    third_party/7zip-sdk-26.00/C/Bcj2.c
    third_party/7zip-sdk-26.00/C/Bra.c
    third_party/7zip-sdk-26.00/C/Bra86.c
    third_party/7zip-sdk-26.00/C/BraIA64.c
    third_party/7zip-sdk-26.00/C/CpuArch.c
    third_party/7zip-sdk-26.00/C/Delta.c
    third_party/7zip-sdk-26.00/C/Lzma2Dec.c
    third_party/7zip-sdk-26.00/C/LzmaDec.c
    third_party/7zip-sdk-26.00/C/Ppmd7.c
    third_party/7zip-sdk-26.00/C/Ppmd7Dec.c
    third_party/7zip-sdk-26.00/C/7zCrc.c
    third_party/7zip-sdk-26.00/C/7zCrcOpt.c
    third_party/7zip-sdk-26.00/C/7zAlloc.c
    third_party/7zip-sdk-26.00/C/7zArcIn.c
    third_party/7zip-sdk-26.00/C/7zBuf.c
    third_party/7zip-sdk-26.00/C/7zBuf2.c
    third_party/7zip-sdk-26.00/C/7zDec.c
    third_party/7zip-sdk-26.00/C/7zFile.c
    third_party/7zip-sdk-26.00/C/7zStream.c
)

add_executable(comic-cache-worker
    src/app/main.cpp
    src/archive/ace_backend.cpp
    src/archive/archive_entry_utils.cpp
    src/archive/libarchive_base.cpp
    src/archive/rar_backend.cpp
    src/archive/sevenz_backend.cpp
    src/archive/zip_backend.cpp
    src/archive/tar_backend.cpp
    src/image/image_pipeline.cpp
    ${SEVEN_Z_SDK_SOURCES}
)

target_include_directories(comic-cache-worker PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/nlohmann-json/include
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/7zip-sdk-26.00/C
    /usr/include/unrar
)

target_compile_definitions(comic-cache-worker PRIVATE
    Z7_PPMD_SUPPORT
    Z7_EXTRACT_ONLY
)

target_link_libraries(comic-cache-worker PRIVATE
    PkgConfig::ARCHIVE
    PkgConfig::VIPS
    ${UNRAR_LIB}
)

add_subdirectory(ace-helper)
add_dependencies(comic-cache-worker comic-cache-ace-helper)

install(TARGETS comic-cache-worker RUNTIME DESTINATION bin)

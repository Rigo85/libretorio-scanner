cmake_minimum_required(VERSION 3.16)
project(comic-cache-worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(ARCHIVE REQUIRED IMPORTED_TARGET libarchive)
pkg_check_modules(VIPS REQUIRED IMPORTED_TARGET vips)
find_library(UNRAR_LIB unrar REQUIRED)

add_executable(comic-cache-worker
    src/app/main.cpp
    src/archive/archive_entry_utils.cpp
    src/archive/libarchive_base.cpp
    src/archive/rar_backend.cpp
    src/archive/sevenz_backend.cpp
    src/archive/zip_backend.cpp
    src/archive/tar_backend.cpp
    src/image/image_pipeline.cpp
)

target_include_directories(comic-cache-worker PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    /usr/include/unrar
)

target_link_libraries(comic-cache-worker PRIVATE
    PkgConfig::ARCHIVE
    PkgConfig::VIPS
    ${UNRAR_LIB}
)

install(TARGETS comic-cache-worker RUNTIME DESTINATION bin)

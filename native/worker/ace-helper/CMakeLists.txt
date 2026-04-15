find_program(MAKE_EXECUTABLE NAMES make REQUIRED)

set(UNACE_VENDOR_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/unace-nonfree)
set(UNACE_VENDOR_BUILD_DIR ${CMAKE_CURRENT_BINARY_DIR}/vendor-build)
set(UNACE_VENDOR_RAW_BINARY ${UNACE_VENDOR_BUILD_DIR}/unace)
set(UNACE_VENDOR_BINARY ${CMAKE_BINARY_DIR}/comic-cache-unace)

file(GLOB_RECURSE UNACE_VENDOR_SOURCES CONFIGURE_DEPENDS
    ${UNACE_VENDOR_DIR}/source/*.c
    ${UNACE_VENDOR_DIR}/source/*.h
    ${UNACE_VENDOR_DIR}/debian/*
    ${UNACE_VENDOR_DIR}/*.mk
    ${UNACE_VENDOR_DIR}/makefile
    ${UNACE_VENDOR_DIR}/licence
)

add_custom_command(
    OUTPUT ${UNACE_VENDOR_BINARY}
    COMMAND ${CMAKE_COMMAND} -E make_directory ${UNACE_VENDOR_BUILD_DIR}
    COMMAND ${MAKE_EXECUTABLE} -C ${UNACE_VENDOR_DIR} clean
    COMMAND ${MAKE_EXECUTABLE} -C ${UNACE_VENDOR_DIR} EXECS_DIR=${UNACE_VENDOR_BUILD_DIR}/
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${UNACE_VENDOR_RAW_BINARY} ${UNACE_VENDOR_BINARY}
    DEPENDS ${UNACE_VENDOR_SOURCES}
    VERBATIM
)

add_custom_target(comic-cache-unace-internal ALL DEPENDS ${UNACE_VENDOR_BINARY})

add_executable(comic-cache-ace-helper
    src/app/main.cpp
    src/helper_archive_utils.cpp
)

set_target_properties(comic-cache-ace-helper PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}
)

target_include_directories(comic-cache-ace-helper PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

add_dependencies(comic-cache-ace-helper comic-cache-unace-internal)

install(TARGETS comic-cache-ace-helper RUNTIME DESTINATION bin)
install(PROGRAMS ${UNACE_VENDOR_BINARY} DESTINATION bin)

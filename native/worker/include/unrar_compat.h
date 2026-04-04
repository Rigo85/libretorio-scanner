#pragma once

/**
 * Compatibility shims for UnRAR's dll.hpp on Linux/non-Windows platforms.
 * The UnRAR DLL API headers use Windows types that don't exist on POSIX.
 */

#ifndef _WIN32

#include <cstdint>

typedef void*    HANDLE;
typedef intptr_t LPARAM;
typedef unsigned int UINT;

#define CALLBACK
#define PASCAL

#endif

#include <dll.hpp>

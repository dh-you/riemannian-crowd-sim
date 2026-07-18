cmake_minimum_required(VERSION 3.26)
project(riemannian_crowd_orca_runner LANGUAGES CXX)

if(NOT DEFINED RVO2_SOURCE_DIR)
  message(FATAL_ERROR "RVO2_SOURCE_DIR must identify the pinned RVO2 checkout")
endif()

set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_DOCUMENTATION OFF CACHE BOOL "" FORCE)
set(ENABLE_OPENMP OFF CACHE BOOL "" FORCE)
set(ENABLE_INSTALLATION OFF CACHE BOOL "" FORCE)
set(ENABLE_PACKAGING OFF CACHE BOOL "" FORCE)
set(ENABLE_HARDENING OFF CACHE BOOL "" FORCE)
add_subdirectory("${RVO2_SOURCE_DIR}" "${CMAKE_BINARY_DIR}/upstream-rvo2" EXCLUDE_FROM_ALL)
target_compile_definitions(RVO PUBLIC RVO_STATIC_DEFINE)

add_executable(orca_runner src/main.cpp)
target_compile_features(orca_runner PRIVATE cxx_std_17)
target_link_libraries(orca_runner PRIVATE RVO::RVO)
set_target_properties(orca_runner PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")

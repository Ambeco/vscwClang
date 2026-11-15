# Change Log

All notable changes to the "vscwClang" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release
- C++ sources compile against prebuilt standard-library headers when the flags allow it (`vscwclang.precompiledHeaders`)
- Multithreaded programs: `std::thread`, `std::mutex`, `pthread` build and run (setting `vscwclang.threads`), and a stop halts every thread; a trap stops in the debugger

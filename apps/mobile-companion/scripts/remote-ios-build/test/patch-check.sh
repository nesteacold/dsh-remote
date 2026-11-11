#!/bin/bash
# Verify the awk-based patch of expo-modules-jsi's nested xcodebuild invocation.
set -u
tmp=$(mktemp -d)
f="$tmp/build-xcframework.sh"
cat >"$f" <<'SRC'
    xcodebuild \
    build \
    SYMROOT="${BUILD_PRODUCTS_PATH}" \
    SWIFT_COMPILATION_MODE=wholemodule \
    CLANG_ENABLE_CODE_COVERAGE=NO \
SRC

/usr/bin/awk '
    /^    SWIFT_COMPILATION_MODE=wholemodule/ {
        print "    SWIFT_VERSION=5 \\"
        print "    OTHER_SWIFT_FLAGS=\"$(inherited) -enable-bare-slash-regex\" \\"
    }
    { print }
' "$f" >"$f.patched" && cat "$f.patched" >"$f" && rm -f "$f.patched"

if grep -q 'SWIFT_VERSION=5' "$f" && grep -q 'enable-bare-slash-regex' "$f"; then
    echo "PATCH_OK"
else
    echo "PATCH_FAILED"
fi
echo "--- patched region ---"
grep -n -A3 'SWIFT_VERSION=5' "$f"
echo "--- still valid shell? ---"
bash -n "$f" && echo "SYNTAX_OK"
rm -rf "$tmp"

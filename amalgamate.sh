#!/usr/bin/env bash

set -euox pipefail

name=cfs

rust_dir=${name}_rust_amalgamated

export CC=clang

create-compile-commands() {
    cp cfe/cmake/Makefile.sample Makefile
    git apply Makefile.diff

    rm -rf sample_defs
    cp -r cfe/cmake/sample_defs sample_defs

    # rm -rf build
    rm -f compile_commands.json
    export PREP_OPTS="-DCMAKE_EXPORT_COMPILE_COMMANDS=On"
    make \
        BUILDTYPE=debug \
        SIMULATION=native \
        ENABLE_UNIT_TESTS=false \
        OMIT_DEPRECATED=false \
        prep
    ln build/native/default_cpu1/compile_commands.json .
}

create-compile-commands

make # creates some config files we need

# skip files with errors
rm -f errors.log files_with_errors.txt
touch errors.log files_with_errors.txt

# Do a fixpoint loop until we get to 0 errors.
# gcc does this in 1-2 iterations, clang takes forever.
while : ; do
    prev_num_files_with_errors=$(wc -l < files_with_errors.txt)
    ./amalgamate.mjs cfs | ("${SHELL}" -euox pipefail || true) &>> errors.log
    rg '([^:]+):[0-9]+:[0-9]+:' --only-matching --replace '$1' < errors.log > files_with_errors.txt
    num_files_with_errors=$(wc -l < files_with_errors.txt)
    if [[ ${num_files_with_errors} -eq ${prev_num_files_with_errors} ]]; then
        break
    fi
done

# all errors should be gone now; we reached a fixpoint of 0 new errors above
echo skipped all errors
./amalgamate.mjs ${name} | "${SHELL}" -euox pipefail

# exit

c2rust transpile \
    --overwrite-existing \
    --emit-build-files \
    --binary ${name}_amalgamated \
    --output-dir ${rust_dir} amalgamated.compile_commands.json \

exit

cp {rust,${rust_dir}}/build.rs
mv ${rust_dir} ${rust_dir}.old
cargo new ${rust_dir}
(cd "${rust_dir}"
    cargo add libc
    cargo add c2rust-bitfields
    cp ../rust/build.rs .
    mv ../${rust_dir}.old/rust-toolchain.toml .
    mv ../${rust_dir}.old/src/${name}_amalgamated.rs src/main.rs
    sed -i 's/#\[macro_use\]//g' src/main.rs
    sed -i 's/extern crate [^;]*;//g' src/main.rs
    sed -i "s/use ::${name}_rust_amalgamated::\*;/use c2rust_bitfields::BitfieldStruct;/" src/main.rs
    cargo fmt
    cargo build
)
rm -rf ${rust_dir}.old

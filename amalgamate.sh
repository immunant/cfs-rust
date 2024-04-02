#!/usr/bin/env bash

set -euox pipefail

name=cfs

rust_dir=${name}_rust_amalgamated

# export CC=clang

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

amalgamated_dir="amalgamated"
errors_log_path=${amalgamated_dir}/errors.log
files_with_errors_path=${amalgamated_dir}/files_with_errors.txt

rm -rf ${amalgamated_dir}
mkdir ${amalgamated_dir}

# ./amalgamate.mjs cfs | \
#     ("${SHELL}" -euox pipefail || true) \
#     |& rg 'error: redefinition of ‘([^’]*)’' --only-matching --replace '$1' \
#     > ${amalgamated_dir}/redefined_identifiers.txt

# # skip files with errors
# rm -f ${errors_log_path} ${files_with_errors_path}
# touch ${errors_log_path} ${files_with_errors_path}

# # Do a fixpoint loop until we get to 0 errors.
# # gcc does this in 1-2 iterations, clang takes forever.
# while : ; do
#     prev_num_files_with_errors=$(wc -l < ${files_with_errors_path})
#     ./amalgamate.mjs cfs | ("${SHELL}" -euox pipefail || true) &>> ${errors_log_path}
#     rg '([^:]+):[0-9]+:[0-9]+:' --only-matching --replace '$1' < ${errors_log_path} > ${files_with_errors_path}
#     num_files_with_errors=$(wc -l < ${files_with_errors_path})
#     if [[ ${num_files_with_errors} -eq ${prev_num_files_with_errors} ]]; then
#         break
#     fi
# done

# all errors should be gone now; we reached a fixpoint of 0 new errors above
# echo skipped all errors
./amalgamate.mjs ${name} | "${SHELL}" -euox pipefail

# binary_name=${name}_amalgamated
binary_name=${name}
c2rust transpile \
    --overwrite-existing \
    --emit-build-files \
    --binary ${binary_name} \
    --output-dir ${rust_dir} ${amalgamated_dir}/compile_commands.json \

rm -rf ${rust_dir}.old
mv ${rust_dir} ${rust_dir}.old
cargo new ${rust_dir}
(cd "${rust_dir}"
    cargo add libc
    cargo add c2rust-bitfields
    # cargo add memoffset
    cargo add f128

    mv ../${rust_dir}.old/build.rs .
    mv ../${rust_dir}.old/rust-toolchain.toml .
    mv ../${rust_dir}.old/src/${binary_name}.rs src/main.rs
    mv ../${rust_dir}.old/src/main.rs.diff src/main.rs.diff
    
    rm -rf ../${rust_dir}.old
    
    sed -i 's/channel = "nightly-2022-08-08"/channel = "nightly-2024-04-01"/' rust-toolchain.toml
    sed -i 's/#\[macro_use\]//g' src/main.rs
    sed -i 's/extern crate [^;]*;//g' src/main.rs
    
    lines=(
        "#![allow(unused_variables)]"
        "#![allow(unused_unsafe)]"
        "#![allow(static_mut_refs)]"

        # "use c2rust_bitfields::BitfieldStruct;" # not used
        # "use memoffset::offset_of;" # replaced by `core::mem::offset_of`
        "use core::mem::offset_of;"
        # "use ::f128;"
    )
    sed -i "s/use ::${name}_rust_amalgamated::\*;/${lines[*]}/" src/main.rs
    
    cargo fmt

    git apply src/main.rs.diff

    cargo fmt
    cargo build
    cargo fix --allow-dirty --allow-staged
)

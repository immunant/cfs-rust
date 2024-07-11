#!/usr/bin/env node

import * as fsp from "fs/promises";
import * as pathLib from "path";
import * as child_process from "child_process";
import { promisify } from "util";
// import * as assert from "assert/strict";

const execFile = promisify(child_process.execFile);

const argv = process.argv.slice(2);
const name = argv[0];

const directory = process.cwd();

const amalgamatedDir = "./amalgamated/";

await fsp.mkdir(amalgamatedDir, { recursive: true });

function amalgamatedPath(fileNameOrExtension) {
    const fileName = fileNameOrExtension.startsWith(".") ? `${name}${fileNameOrExtension}` : fileNameOrExtension;
    return pathLib.resolve(`${amalgamatedDir}/${fileName}`);
}

async function readLines(path) {
    let buf;
    try {
        buf = await fsp.readFile(path);
    } catch {
        return [];
    }
    return buf
        .toString()
        .split("\n")
        .filter(Boolean)
        ;
}

const filesWithErrorsPath = amalgamatedPath("files_with_errors.txt");
const filesWithErrors = new Set((await readLines(filesWithErrorsPath))
    .map(path => pathLib.relative(".", path))
);
console.warn(`skipping ${filesWithErrors.size} files with errors`);
await fsp.writeFile(filesWithErrorsPath, [...filesWithErrors].join("\n"));

const flagsClangDoesntKnow = new Set([
    // "-Wno-format-truncation",
    // "-Wno-stringop-truncation",
]);

const skippedFiles = new Set([
    // We use the real definitions in "psp/fsw/pc-linux/src/cfe_psp_start.c".
    "osal/src/bsp/shared/src/bsp_default_app_startup.c",
    "osal/src/bsp/shared/src/bsp_default_app_run.c",
]);

async function amalgamate({ redefinitions }) {
    // console.log(redefinitions);

    let seen = new Set();

    const commands = JSON.parse((await fsp.readFile("compile_commands.json")).toString())
        .flatMap(({ directory, file, output, command, arguments: args }) => {
            const relativePath = pathLib.relative(".", file);

            if (seen.has(relativePath)) {
                return [];
            }
            seen.add(relativePath);

            args = args ?? command.split(/ +/g);
            command = args.join(" ");

            const flags = args
                .slice(
                    ["cc"].length, // Slice off the compiler invocation (not a flag).
                    -["-o", "obj", "-c", "src"].length, // Slice off the file-specific args that aren't flags.
                )
                .filter(flag => !flagsClangDoesntKnow.has(flag))
                ;

            const definePrefix = "-D";
            const defineSep = "=";
            let commonDefines = new Set();
            const setCommonDefines = (defines) => {
                commonDefines = defines;
            };
            const existingDefines = () => flags
                .filter(flag => flag.startsWith(definePrefix))
                .filter(define => !commonDefines.has(define))
                .map(flag => {
                    const [name, ...rest] = flag
                        .slice(definePrefix.length)
                        .split(defineSep);
                    let value = rest.join(defineSep);
                    value = value.replaceAll('\\"', '\"');
                    return { name, value, flag };
                });
            const pathIdentifier = relativePath.replace(/\W+/g, '_');
            const defines = () => [
                ...existingDefines(),
                ...(redefinitions[file] ?? [])
                    // ...[...new Set(Object.values(redefinitions).flat())]
                    .map(name => ({ name, value: `${pathIdentifier}__${name}` })),
            ];

            const flagsWithoutDefines = flags.filter(flag => !flag.startsWith(definePrefix));

            const includeLines = () => [
                ...defines().map(({ name, value }) => `#define ${name} ${value}`),
                `#include "${relativePath}"`,
                ...defines().reverse().map(({ name }) => `#undef ${name}`),
            ];

            const namespace = relativePath.replace(/\W/g, '_');

            return [{
                directory,
                file,
                relativePath,
                output,
                command,
                arguments: args,
                flags,
                defines,
                setCommonDefines,
                flagsWithoutDefines,
                includeLines,
                namespace,
            }];
        })
        // Exclude unit tests as that compiles things twice, leading to redefinition errors.
        .filter(e => !e.defines().find(define => define.name === "_UNIT_TEST_"))
        .filter(e => !skippedFiles.has(e.relativePath))
        ;

    function intersection(...sets) {
        const counter = new Map();
        for (const set of sets) {
            for (const e of set) {
                counter.set(e, (counter.get(e) ?? 0) + 1);
            }
        }
        return [...counter.entries()]
            .filter(([e, count]) => count == sets.length)
            .map(([e, count]) => e)
            ;
    }

    // defines defined by every translation unit
    const commonDefines = new Set(intersection(...commands.map(cmd => cmd.defines().map(define => define.flag))));

    const flags = [
        ...new Set(commands.flatMap(e => e.flagsWithoutDefines)),
        ...commonDefines,
        // "-ferror-limit=0",
        "-Wno-unknown-warning-option",
        `-I${directory}`,
    ];

    commands.forEach(cmd => {
        cmd.setCommonDefines(commonDefines);
    });

    const includes = [
        {
            includeLines: () => [
                // Need to define `_GNU_SOURCE` the first time we `#include` these.
                "#define _GNU_SOURCE",
                "#include <pthread.h>",
                "#include <sched.h>",
                "#undef _GNU_SOURCE",
            ],
        },
        ...commands
            .filter(cmd => !filesWithErrors.has(cmd.relativePath)),
    ]
        .map(cmd => cmd.includeLines().join("\n"))
        .join("\n\n")
        + "\n"
        ;

    const linkFlags = [];

    const cc = process.env.CC ?? "cc";

    const amalgamated = {
        ii: {
            // A post-preprocessing file, just to check exactly what's included or not.
            directory,
            arguments: [cc, ...flags, "-o", amalgamatedPath(".ii"), "-E", amalgamatedPath(".c")],
            file: amalgamatedPath(".c"),
        },
        o: {
            directory,
            arguments: [cc, ...flags, "-o", amalgamatedPath(".o"), "-c", amalgamatedPath(".c")],
            file: amalgamatedPath(".c"),
        },
        exe: {
            directory,
            arguments: [cc, ...flags, "-o", amalgamatedPath("exe"), amalgamatedPath("c"), ...linkFlags],
            file: amalgamatedPath(".c"),
        },
    };

    return {
        amalgamated,
        includes,
    };
}



function toShellCommand(cmd) {
    const command = cmd.arguments && cmd.arguments.join(" ") || cmd.command;
    return `(cd "${cmd.directory}" && ${command})`;
}

async function runCommand(cmd, ...extraArgs) {
    let [exe, ...args] = [...cmd.arguments, ...extraArgs];
    try {
        return await execFile(exe, args, {
            cwd: cmd.directory,
            maxBuffer: 1_000_000_000,
        });
    } catch (e) {
        return e;
    }
}

async function redefinitions({ amalgamated }) {
    const { stderr } = await runCommand(amalgamated.o, "-fdiagnostics-format=json");
    const errors = JSON.parse(stderr);
    return errors
        .filter(error => error.message.match(/^rede(fini|clara)tion of /))
        .map(error => {
            const start = error.message.lastIndexOf("‘");
            const end = error.message.lastIndexOf("’");
            const identifier = error.message
                .slice(start + 1, end)
                .replace(/^(struct|union|enum) /, "")
                ;
            const path = error.locations[0].caret.file;
            return { identifier, path };
        })
        .reduce((groups, { identifier, path }) => {
            (groups[path] = groups[path] ?? []).push(identifier);
            return groups;
        }, {})
        ;
}

async function writeAmalgamatedCommands(stage) {
    const commands = [stage.amalgamated.o];

    await fsp.writeFile(amalgamatedPath(".c"), stage.includes);
    await fsp.writeFile(amalgamatedPath("compile_commands.json"), JSON.stringify(commands, null, 4));
}

async function main() {
    const stage1 = await amalgamate({ redefinitions: [] });
    await writeAmalgamatedCommands(stage1);

    const stage2 = await amalgamate({ redefinitions: await redefinitions({ amalgamated: stage1.amalgamated }) });
    await writeAmalgamatedCommands(stage2);

    console.log(toShellCommand(stage2.amalgamated.ii));
    console.log(toShellCommand(stage2.amalgamated.o));
}

await main();

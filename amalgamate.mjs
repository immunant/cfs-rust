#!/usr/bin/env node

import * as fsp from "fs/promises";
import * as pathLib from "path";
// import * as assert from "assert/strict";

const argv = process.argv.slice(2);
const name = argv[0];

const directory = process.cwd();

const amalgamatedDir = "./amalgamated/";

await fsp.mkdir(amalgamatedDir, { recursive: true });

function amalgamatedPath(fileNameOrExtension) {
    const fileName = fileNameOrExtension.startsWith(".") ? `${name}${fileNameOrExtension}` : fileNameOrExtension;
    return pathLib.resolve(`${amalgamatedDir}/${fileName}`);
}

const filesWithErrorsPath = amalgamatedPath("files_with_errors.txt");
const filesWithErrors = new Set((await fsp.readFile(filesWithErrorsPath))
    .toString()
    .split("\n")
    .filter(Boolean)
    .map(path => pathLib.relative(".", path))
);
console.warn(`skipping ${filesWithErrors.size} files with errors`);
await fsp.writeFile(filesWithErrorsPath, [...filesWithErrors].join("\n"));

const flagsClangDoesntKnow = new Set([
    // "-Wno-format-truncation",
    // "-Wno-stringop-truncation",
]);

const commands = JSON.parse((await fsp.readFile("compile_commands.json")).toString())
    .map(({ directory, file, output, command, arguments: args }) => {
        const relativePath = pathLib.relative(".", file);

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
        const defines = () => flags
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

        const flagsWithoutDefines = flags.filter(flag => !flag.startsWith(definePrefix));

        const includeLines = () => [
            ...defines().map(({ name, value }) => `#define ${name} ${value}`),
            `#include "${relativePath}"`,
            ...defines().reverse().map(({ name }) => `#undef ${name}`),
        ];

        const namespace = relativePath.replace(/\W/g, '_');

        return {
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
        };
    })
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

const amalgamatedCommands = [amalgamated.o];

await fsp.writeFile(amalgamatedPath(".c"), includes);
await fsp.writeFile(amalgamatedPath("compile_commands.json"), JSON.stringify(amalgamatedCommands, null, 4));

function toShellCommand(cmd) {
    const command = cmd.arguments && cmd.arguments.join(" ") || cmd.command;
    return `(cd "${cmd.directory}" && ${command})`;
}

console.log(toShellCommand(amalgamated.ii));
console.log(toShellCommand(amalgamated.o));

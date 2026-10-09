import { mkdir, copyFile } from "node:fs/promises";
await mkdir(new URL("../dist/styles/", import.meta.url), { recursive: true });
await copyFile(new URL("../src/styles/frameBudget.css", import.meta.url), new URL("../dist/styles/frameBudget.css", import.meta.url));

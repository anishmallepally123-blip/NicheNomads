// One entry point for setup / dev / build / start / test, so nobody has to
// remember virtualenv paths. Works on Windows, macOS and Linux.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backend = join(root, "backend");
const frontend = join(root, "frontend");
const win = process.platform === "win32";
const venvPython = join(backend, ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
const npm = win ? "npm.cmd" : "npm";

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: win });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function findPython() {
  for (const cmd of win ? ["py", "python"] : ["python3", "python"]) {
    if (spawnSync(cmd, ["--version"], { shell: win }).status === 0) return cmd;
  }
  console.error("Python 3.10+ is required. Install it from https://www.python.org/downloads/");
  process.exit(1);
}

function needSetup() {
  if (!existsSync(venvPython) || !existsSync(join(frontend, "node_modules"))) {
    console.error("Run `npm run setup` first.");
    process.exit(1);
  }
}

const tasks = {
  setup() {
    if (!existsSync(venvPython)) run(findPython(), ["-m", "venv", ".venv"], backend);
    run(venvPython, ["-m", "pip", "install", "-q", "-r", "requirements.txt"], backend);
    run(npm, ["install"], frontend);
    console.log("\nSetup done. Start the app with: npm run dev");
  },
  dev() {
    needSetup();
    const procs = [
      spawn(venvPython, ["-m", "uvicorn", "app.main:app", "--reload", "--port", "8000"],
        { cwd: backend, stdio: "inherit" }),
      spawn(npm, ["run", "dev"], { cwd: frontend, stdio: "inherit", shell: win }),
    ];
    const stop = () => procs.forEach((p) => p.kill());
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    procs.forEach((p) => p.on("exit", stop));
    console.log("\nOpen http://localhost:5173\n");
  },
  build() {
    needSetup();
    run(npm, ["run", "build"], frontend);
  },
  // Production style: one server on :8000 serving both the API and the built site.
  start() {
    needSetup();
    if (!existsSync(join(frontend, "dist"))) tasks.build();
    run(venvPython, ["-m", "uvicorn", "app.main:app", "--host", "0.0.0.0",
      "--port", process.env.PORT ?? "8000"], backend);
  },
  test() {
    needSetup();
    run(venvPython, ["-m", "pytest", "-q"], backend);
    run(npm, ["run", "typecheck"], frontend);
  },
};

const task = tasks[process.argv[2]];
if (!task) {
  console.error(`Usage: npm run <${Object.keys(tasks).join("|")}>`);
  process.exit(1);
}
task();

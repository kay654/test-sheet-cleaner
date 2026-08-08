import { returnString, umdString } from "./umd";
import * as buble from "buble";
import { exec } from "child_process";
import { watch } from "chokidar";
import * as fs from "fs";
import * as path from "path";
import * as uglify from "uglify-js";

let currentlyBuilding = false;
let watching = process.argv.indexOf("-w") !== -1;

function execute(cmd: string): any {
	return new Promise((resolve, reject) => {
		exec(cmd, (error, stdout, stderr) => {
			if (!error) {
				if (stdout) {
					console.log("🔨", stdout);
				}
			} else {
				console.log("🔨", "ERROR");
				console.log("🔨", error);
				console.log("🔨", stderr);
			}
			resolve();
		});
	});
}

async function startBuild() {
	console.log("🔨 🔨 Starting a new build");
	console.log("🔨 🏁 Cleaning dist directory");
	fs.rmdirSync("./dist", {
		recursive: true
	})
	console.log("🔨 🧱 Compiling from typescript");
	await execute("tsc --p tsconfig.json && tsc --p ./src/tsconfig.json");
	console.log("🔨 📄 Reading library files");
	const libheif = fs.readFileSync("./src/libheif.js", { encoding: "utf8" });
	const gifshot = fs.readFileSync("./src/gifshot.js", { encoding: "utf8" });
	console.log("🔨 📄 Reading main files");
	let main = fs.readFileSync("./dist/heic2any.js", { encoding: "utf8" });
	let worker = fs.readFileSync("./dist/worker.js", { encoding: "utf8" });
	console.log("🔨 📄 Creating worker code");
	worker = `var workerString = \`\n${(watching
		? libheif
		: uglify.minify(libheif).code
	).replace(
		/(\\)/g,
		"\\\\"
	)}\n${worker}\n\`;\nvar blob = new Blob([workerString], {type: 'application/javascript'});\nwindow.__heic2any__worker = new Worker(URL.createObjectURL(blob));`;

	console.log("🔨 📄 Fixing main files");
	main = worker + main;
	main = main.split(`require("./libheif")`).join("");
	main = main.split(`require("./gifshot")`).join("");
	main = main.split(`import "./libheif"`).join("");
	main = main.split(`import "./gifshot"`).join("");
	main = main
		.split(`Object.defineProperty(exports, "__esModule", { value: true })`)
		.join("");
	main = main.split(/exports\.default = heic2any/).join("");

	let lib = gifshot + umdString + main + returnString;

	console.log("🔨 🧱 Transpiling with buble");
	lib = buble.transform(lib).code;
	console.log("🔨 📄 Writing final library files");
	fs.writeFileSync("./dist/heic2any.js", lib);
	if (!watching) {
		console.log("🔨 🔩 Minifying code");
		let libMin = uglify.minify(lib).code;
		fs.writeFileSync("./dist/heic2any.min.js", libMin);
	}
	console.log("🔨 📄 Removing extra files");
	fs.unlinkSync("./dist/worker.d.ts");
	fs.unlinkSync("./dist/worker.js")
	console.log("🔨 🏁 Build finished successfully");
}

startBuild().then((x) => {
	if (watching) {
		console.log("🔨 👀 - Watching for changes");
		watch(path.resolve("src/")).on("all", (ev) => {
			if (currentlyBuilding) {
				return;
			}
			if (["change", "unlink", "unlinkDir"].indexOf(ev) > -1) {
				console.log(
					"🔨 🏁 CHANGE OCCURRED AT",
					new Date().toLocaleTimeString()
				);
				currentlyBuilding = true;
				startBuild().then(() => {
					currentlyBuilding = false;
				});
			}
		});
	}
});

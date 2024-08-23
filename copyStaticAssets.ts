import shell from "shelljs";
import path from "path";

shell.mkdir("-p", "dist/public/covers");
shell.mkdir("-p", "dist/public/temp_covers");
shell.mkdir("-p", "dist/public/cache");
shell.mkdir("-p", "dist/public/books");

const publicDir = path.join("dist/public", __dirname.slice(1), "dist/public");
shell.mkdir("-p", publicDir);
shell.ln("-s", path.join(__dirname, "dist/public/books"), path.join(publicDir, "books"));

shell.cp("-R", "src/browser/*", "dist/public");

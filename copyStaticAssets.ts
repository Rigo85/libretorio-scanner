import shell from "shelljs";

// // shell.rm("-rf", "dist/public/*");
shell.cp("-R", "src/services/calibre", "dist/services");
shell.mkdir("-p", "dist/public/covers");
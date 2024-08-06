import shell from "shelljs";

// // shell.rm("-rf", "dist/public/*");
shell.cp("-R", "src/services/calibre", "dist/services");
shell.mkdir("-p", "dist/public/covers");
shell.mkdir("-p", "dist/public/temp_covers");
shell.mkdir("-p", "dist/public/cache");

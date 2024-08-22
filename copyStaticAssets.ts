import shell from "shelljs";

shell.cp("-R", "src/services/calibre", "dist/services");
shell.mkdir("-p", "dist/public/books");

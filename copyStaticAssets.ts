import shell from "shelljs";
import path from "path";

shell.cp("-R", "src/services/calibre", "dist/services");
// shell.mkdir("-p", "dist/public/covers");
// shell.mkdir("-p", "dist/public/temp_covers");
// shell.mkdir("-p", "dist/public/cache");
// shell.mkdir("-p", "dist/public/books");
shell.mkdir("-p", "dist/public");

// const publicDir = path.join("dist/public", __dirname.slice(1), "dist/public");
// shell.mkdir("-p", publicDir);
// shell.ln("-s", path.join(__dirname, "dist/public/books"), path.join(publicDir, "books"));
shell.ln("-s", "/media/RIGO7/BACKUP/LIBROS", "dist/public/books");
shell.ln("-s", "/media/RIGO7/Libretorio-conf/covers", "dist/public/covers");
shell.ln("-s", "/media/RIGO7/Libretorio-conf/cache", "dist/public/cache");
shell.ln("-s", "/media/RIGO7/Libretorio-conf/temp_covers", "dist/public/temp_covers");


// shell.cp("-R", "src/browser/*", "dist/public");

import { execSync } from "child_process";

const run = (cmd: string) => execSync(cmd, {stdio: "inherit"});
const tryRun = (cmd: string) => { try { run(cmd); } catch { /* optional resource */ } };

tryRun("cp -R src/services/calibre dist/services");
run("mkdir -p dist/public");
run("ln -sfn /media/RIGO7/BACKUP/LIBROS dist/public/books");
run("ln -sfn /media/RIGO7/Libretorio-conf/covers dist/public/covers");
run("ln -sfn /media/RIGO7/Libretorio-conf/cache dist/public/cache");
run("ln -sfn /media/RIGO7/Libretorio-conf/temp_covers dist/public/temp_covers");

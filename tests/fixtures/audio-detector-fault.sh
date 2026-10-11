#!/bin/sh
# Test-only executable: replace the process so timeout tests leave no children.
for argument do
    case "$argument" in
        */detector-hang) exec /bin/sleep 10 ;;
        */detector-crash) kill -KILL "$$" ;;
        */detector-bad-response) printf 'invalid-output'; exit 0 ;;
        */detector-uppercase) printf '%s\000application/vnd.hp-HPGL\000' "$argument"; exit 0 ;;
    esac
done
exec /usr/bin/file "$@"

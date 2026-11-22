set -e
php -v | head -1
mkdir -p /tmp/w && cd /tmp/w
printf '%s' '<?php $fh=fopen("/tmp/w/lk","c"); $ok=flock($fh,LOCK_EX|LOCK_NB); $GLOBALS["k"][]=$fh; echo $ok?"locked":"busy";' > a.php
php -S 127.0.0.1:8099 -t /tmp/w >/dev/null 2>&1 & sleep 1
echo "req1 $(curl -s 127.0.0.1:8099/a.php)"; echo "req2 $(curl -s 127.0.0.1:8099/a.php)"
php -r '$f=fopen("/tmp/w/lk","c"); echo "CLI ", flock($f,LOCK_EX|LOCK_NB)?"libero":"OCCUPATO-leak", "\n";'

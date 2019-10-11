
git pull
npm ci
npx tsc
DATE=$(date +%d%m%y)
TIME=$(date +%H%M)
mkdir -p archive/$DATE-$TIME
mv logs/* archive/$DATE-$TIME
kill $(ps aux | grep '[H]eise-Feed' | awk '{print $2}')
bash -c "exec -a Heise-Feed node build 2> logs/error.log > logs/log.log &"

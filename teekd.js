var request = require('request');
var cheerio = require('cheerio');
var fs = require('fs');
//var auth = require('./auth.json');
const puppeteer = require('puppeteer');

// set up defaults
var defaults = {};
    defaults.proxy = {
        host: '127.0.0.1',
        port: '8000',
        user: '',
        pass: ''
    };
    defaults.auth = {
        user: '',
        pass: ''
    };
    defaults.settings = {
        datadir: '/tmp',
        webhookURL: ''
    }
    defaults.lastPost = {
        date: '2017-12-22T10:25:00'
    };

// create config file if it does not exist, and set defaults
var conf_file = './auth.json';

if( ! fs.existsSync(conf_file) ) {
    fs.writeFileSync( conf_file, JSON.stringify(defaults,null, 2) );
}
// load the config file
var nconf = require('nconf');
    nconf.file({file: conf_file});
    nconf.load();

let proxyConf = nconf.get('proxy');
let authConf = nconf.get('auth');
let settings = nconf.get('settings');
let lastPost = nconf.get('lastPost');

const pOpts = {
    args: [
        `--proxy-server=${proxyConf.host}:${proxyConf.port}`
    ],
    userDataDir: settings.datadir
}

var proxiedRequest = request.defaults({
    'proxy': `http://${proxyConf.user}:${proxyConf.pass}@${proxyConf.host}:${proxyConf.port}`,
    'rejectUnauthorized': false,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2228.0 Safari/537.36'
      }
});

var openRequest = request.defaults({
    'rejectUnauthorized': false,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2228.0 Safari/537.36'
      }
});

function uniq(a) {
    var prims = {"boolean":{}, "number":{}, "string":{}}, objs = [];
    return a.filter(function(item) {
        var type = typeof item;
        if(type in prims)
            return prims[type].hasOwnProperty(item) ? false : (prims[type][item] = true);
        else
            return objs.indexOf(item) >= 0 ? false : objs.push(item);
    });
}

var afterDate = lastPost.date;

function postCheckLoop() {
    console.log('Checking for new posts...');
    openRequest.get(`http://www.palmbeachgroup.com/wp-json/wp/v2/posts?after=${afterDate}`, function(error, response, body) {
        if (!error && response.statusCode == 200) {
            if (response.body) {
                var posts = JSON.parse(response.body);
                if (posts.length > 0) {
                    afterDate = posts[0].date;
                    nconf.set('lastPost', {'date': afterDate});
                    nconf.save();
                    postLoop(posts);
                } else {
                    console.log(`No new posts`);
                }
           }
        } else {
            console.log('Error or status not equal 200.');
            console.log(error);
            console.log(response.body);
        }
    });

    var rand = Math.floor(Math.random()*(30000-5000+1)+5000);
    console.log(`Checking in ${rand / 1000} seconds`);
    setTimeout(postCheckLoop, rand);
}

postCheckLoop();
//var intervalID = setInterval(postCheckLoop, 60000);

function postLoop(posts) {
    var post = posts.shift();
    var delay = 5000;
    var catString;
    if (post.categories.indexOf(33) > -1) {
        catString = 'Update';
    } else if (post.categories.indexOf(17) > -1) {
        catString = 'Monthly Issue';
    } else {
        catString = 'Unknown Category';
    }
    if (!post.retryCount) {
        post.retryCount = 0;
    }
    console.log('\n==================\n');
    console.log(`Post: ${post.id} Title: ${post.title.rendered.replace(/<[^>]+>/g, '')}`);
    console.log(`URL: ${post.link} Type: ${post.type}`);
    console.log(`Retry Count: ${post.retryCount}\n`);
    console.log('Waiting 5 seconds...\n');

    if(post.retryCount == 0) {
        var init_data = {};
        init_data.username = `TeekaBot`;
        init_data.content = `@everyone Standby for PBC ${catString}: ${post.title.rendered.replace(/<[^>]+>/g, '')}`;
        var initHook = {
            method: 'post',
            body: init_data,
            json: true,
            url: settings.webhookURL
        }
        request(initHook, function(err, res, body) {
            if (err) {console.error('error posting json: ', err)};
        });
    }

    setTimeout(function() {
        console.log('==================\n');
        var title = post.title.rendered.replace(/<[^>]+>/g, '');
        var url = post.link;
        //var url = 'https://httpstat.us/500';
        var id = post.id;
    
        puppeteer.launch(pOpts).then(async browser => {
            var page = await browser.newPage();
            page.authenticate({username: proxyConf.user, password: proxyConf.pass});
            page.setViewport({width: 1680, height: 1024});
            process.on("unhandledRejection", (reason, p) => {
                console.error("Unhandled Rejection at: Promise", p, "reason:", reason);
                if (browser)
                    browser.close();
                return('error');
              });
            var navResponse = await page.goto(url);
            if (navResponse.status != 200) {
                console.error(`Error: Response code ${navResponse.status} received.\n`);
                console.error(navResponse.headers);
                browser.close();
                return('error');
            }
    
            if (await page.$('#user_login') !== null) {
                console.log('not logged in');
                await page.waitForSelector('#user_login', {'visible': true});
                var email = await page.$('#user_login');
                await email.focus();
                await email.type(authConf.user);
                await page.waitFor(121);
                var pass = await page.$('#user_pass');
                await pass.focus();
                await pass.type(authConf.pass);
                await page.waitFor(206);
                await page.tap('#rememberme');
                await page.tap('#wp-submit');
                await page.waitFor(5000);
                await page.screenshot({path: 'screenshot.png'});
            } else {
                console.log('already logged in');
            }

            if (await page.$('.error') !== null) {
                console.log(`cannot access this article`);
                await browser.close();
                return('no-access');
            }

            await page.waitForSelector('.contt', {'visible': true});
            var contentSel = await page.$('.contt');
            await contentSel.screenshot({path: 'article.png'});
            page.$eval('.contt', function(content) {
                return content.innerHTML;
            }).then(function(result) {
                var $ = cheerio.load(result);
                $('.pbrg-box-100').remove();
                var fullText = $.text();
                //console.log(fullText);
                console.log('==============\n\n');
                var matches = [];
                $('strong').each(function(i, elem) {
                    matches.push($(this).parent().text());
                  });
                var uniqMatch = uniq(matches);
                var primaryCoin;
                var primaryText;
                var coinArr = [];
                var actionArr = [];
                var junkArr = [];
                for (i in uniqMatch) {
                    if (uniqMatch[i].indexOf('Important note:') == -1) {
                        if (uniqMatch[i].indexOf('Action') > -1 || uniqMatch[i].indexOf('Buy-up-to') > -1) {
                            if (uniqMatch[i].indexOf('Buy-up-to') > -1) {
                                var coinMatch = uniqMatch[i].match(/\([0-9A-Z^]+\)/g);
                                console.log(coinMatch);
                                if (coinMatch && coinMatch.length > 0)
                                    primaryCoin = coinMatch[0];
                                else
                                    primaryCoin = 'unknown';
                                primaryText = uniqMatch[i];
                                coinArr = coinArr.concat(uniqMatch[i].match(/\([0-9A-Z^]+\)/g));
                            } else {
                                coinArr = coinArr.concat(uniqMatch[i].match(/\([0-9A-Z^]+\)/g));
                                actionArr.push(uniqMatch[i]);
                            }
                        } else {
                            junkArr.push(uniqMatch[i]);
                        }
                    }
                }

                var post_data = {};
                    post_data.username = `TeekaBot`;
                var postContent = `**${title}**\n\n`;

                if (primaryCoin && primaryText) {
                    console.log(`Primary Coin: ${primaryCoin}`);
                    postContent += `**Primary Coin: ${primaryCoin}**\n\n`;
                    console.log(`Primary Text: ${primaryText}`);
                    postContent += `**Primary Text:**\n\n${primaryText}\n\n`;
                    if(uniq(coinArr).length == 1 && uniq(coinArr)[0] == primaryCoin) {
                        console.log('\nNo extra coins');
                    } else {
                        console.log(`\nOther Coins: ${uniq(coinArr)}`);
                        postContent += `Other Coins: ${uniq(coinArr)}\n\n`;
                    }
                    if(uniq(actionArr).length > 0) {
                        console.log(`\nActions:\n\n${uniq(actionArr).join('\n')}`);
                        postContent += `Actions:\n\n${uniq(actionArr).join('\n')}`;
                    }
                } else if (actionArr.length > 0) {
                    console.log(`Coins Mentioned: ${uniq(coinArr)}`);
                    postContent += `**Coins Mentioned:** ${uniq(coinArr)}\n`;
                    console.log(`\nActions:\n\n${uniq(actionArr).join('\n')}`);
                    postContent += `\n\n**Actions:**\n\n${uniq(actionArr).join('\n')}`;
                    console.log(`\nHighlights:\n\n${uniq(junkArr).join('\n')}`);
                    postContent += `\n\n**Other Info:**\n\n${uniq(junkArr).join('\n')}`;
                } else {
                    console.log(`Couldn't find anything useful:\n\n${junkArr.join('\n')}`);
                    postContent += `No coins found:\n\n${junkArr.join('\n')}`;
                }

                if (postContent.length > 1500) {
                    var trimContent = postContent.substring(0, 1500);
                    postContent = trimContent;
                }

                var hookOpts = {
                    method: 'post',
                    body: post_data,
                    json: true,
                    url: settings.webhookURL
                }

                var req = request.post(settings.webhookURL, function (err, resp, body) {
                    if (err) {
                        console.log('Error posting webhook!');
                        console.log(err);
                    } else {
                        console.log('webhook posted\n');
                    }
                });
                var form = req.form();
                    form.append('username', post_data.username);
                    form.append('content', postContent);
                    form.append('file', fullText, {
                        filename: `${id}.txt`,
                        contentType: 'text/plain'
                    });
                browser.close();
                if(posts.length)
                    console.log('more posts to go\n');
                else {
                    console.log('all posts done\n');
                }
            });
        }).then(function (retVal) {
            console.log(retVal);
            if(retVal && retVal == 'error') {
                post.retryCount++;
                if(post.retryCount < 30) {
                    posts.unshift(post);
                    console.log('error accessing post, retrying');
                } else {
                    console.log(`max retries hit, giving up`);
                    var retry_data = {};
                        retry_data.username = `TeekaBot`;
                        retry_data.content = `Error: Couldn't access PBC Post ${title}\nGave up after 30 retries.`;
                    var retryHook = {
                        method: 'post',
                        body: retry_data,
                        json: true,
                        url: settings.webhookURL
                    }
                    request(retryHook, function(err, res, body) {
                        if (err) {console.error('error posting json: ', err)};
                    });
                }
            }
            if(retVal && retVal == 'no-access') {
                console.log('no access to post, not retrying');
                var err_data = {};
                    err_data.username = `TeekaBot`;
                    err_data.content = `Error: Couldn't access PBC Post ${title}`;
                var errHook = {
                    method: 'post',
                    body: err_data,
                    json: true,
                    url: settings.webhookURL
                }
                request(errHook, function(err, res, body) {
                    if (err) {console.error('error posting json: ', err)};
                });
            }
            if(posts.length) {
                postLoop(posts);
            } else {
                console.log('all complete\n\n');
            }
        }, function(err) {
            console.log('connection failed, retrying');
            if (err)
                console.log(err);
                post.retryCount++;
            if(post.retryCount < 30) {
                posts.unshift(post);
                console.log('error accessing post, retrying');
            } else {
                console.log(`max retries hit, giving up`);
                var retry_data = {};
                    retry_data.username = `TeekaBot`;
                    retry_data.content = `Error: Couldn't access PBC Post ${title}\nGave up after 30 retries.`;
                var retryHook = {
                    method: 'post',
                    body: retry_data,
                    json: true,
                    url: settings.webhookURL
                }
                request(retryHook, function(err, res, body) {
                    if (err) {console.error('error posting json: ', err)};
                });
            }
            postLoop(posts);
        });
        //console.log('inside of settimeout function\n');
    }, delay);
    //console.log('outside of settimeout function\n');
}
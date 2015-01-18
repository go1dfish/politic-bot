# PoliticBot / ModerationLog

Reddit bot that mirrors political subreddits (PoliticBot) and then reports on posts removed by moderators (ModerationLog)

Used to power [/r/POLITIC](http://reddit.com/r/POLITIC) and [/r/ModerationLog](http://reddit.com/r/ModerationLog)

## Requirements

 * A reddit account capable of posting/commenting without captchas
   * (optional) All multi-reddits on the account are used to find topical posts
 * Two subreddits the account has mod priviledges for
   * Both subreddits should have link flair enabled
   * A mirror subreddit like /r/POLITIC
     * 'meta' and 'removed' link flair templates
     * AutoModerator is recommended to approve all posts from bot.
   * A report subreddit like /r/ModerationLog
     * 'removed' and 'flairedremoval' link flair templates
 * node/npm

## Instructions

    git clone https://github.com/go1dfish/politic-bot.git
    cd politic-bot
    cp config.json.example config.json
    edit config.json // Configure your account/subreddits
    npm install && npm install -g forever
    npm start
    cat out.log
    cat err.log
    npm stop

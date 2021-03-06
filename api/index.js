const Koa = require('koa');
const cors = require('@koa/cors');
const bodyParser = require('koa-bodyparser');
const session = require('koa-session');
const Router = require('koa-router');
const Knex = require('knex');
const passport = require('koa-passport');
const fetch = require('node-fetch');
const cron = require('node-cron');
const OAuth2Strategy = require('passport-oauth2');

const PORT = parseInt(process.env.PORT || '') || 3001;
const DB_URI = process.env.DB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_HOST_URL = process.env.GITHUB_HOST_URL || ('http://localhost:' + PORT);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

if (process.env.NODE_ENV == 'production' && DB_URI == undefined) {
  throw new Error('DB_URI must be set with production NODE_ENV');
}
if (SESSION_SECRET == undefined) {
  throw new Error('SESSION_SECRET must be set');
}
if (GITHUB_CLIENT_ID == undefined) {
  throw new Error('GITHUB_CLIENT_ID must be set');
}
if (GITHUB_CLIENT_SECRET == undefined) {
  throw new Error('GITHUB_CLIENT_SECRET must be set');
}

const app = new Koa();
const router = new Router();
const knex = Knex(process.env.NODE_ENV == 'production' ? DB_URI : {
  connection: { filename: 'dev.db' },
  client: 'sqlite3',
  useNullAsDefault: true,
});

passport.use(new OAuth2Strategy({
  authorizationURL: 'https://github.com/login/oauth/authorize',
  tokenURL: 'https://github.com/login/oauth/access_token',
  clientID: GITHUB_CLIENT_ID,
  clientSecret: GITHUB_CLIENT_SECRET,
  callbackURL: GITHUB_HOST_URL + '/auth/github/callback',
  scope: '', // grant read-only access to public information
}, async (accessToken, unusedRefreshToken, unusedProfile, done) => {
  const profileData = await getProfileData(accessToken);

  const count = await knex('users')
    .count('name', {as: 'count'})
    .where('name', profileData.name) // TODO identify by id, not by name
    .then(result => result[0].count);
  console.log(profileData)

  const user = {
      ...profileData,
      access_token: accessToken,
  };

  if (count == 0) {
    await knex('users').insert({
      ...user,
      story: '',
      kudos: 0,
    });
    console.log('registered ' + profileData.name);
  } else {
    // store new access token
    await knex('users').update(user).where('name', profileData.name);
    console.log('updated ' + profileData.name);
  }

  // put name into ctx.state.user
  done(null, profileData.name);
}));

// serialize ctx.state.user <-> cookie
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

app.keys = [SESSION_SECRET];
app.use(session({}, app));
app.use(bodyParser());
app.use(passport.initialize());
app.use(passport.session());
app.use(cors({
  credentials: true,
}));

async function getProfileData(accessToken) {
  const outbreak = '2020-03-11T00:00:00Z'; // the WHO officially declares the coronavirus outbreak to be a pandemic
  const now = new Date().toISOString();
  const query = `
    query {
      viewer {
        login
        avatarUrl
        contributionsCollection(from: "${outbreak}", to: "${now}") {
          contributionCalendar {
            weeks {
              contributionDays {
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message);
  }
  const { data } = await response.json();

  // data.viewer.contributionsCollection.contributionCalendar is sorted
  const days = [].concat(...data.viewer.contributionsCollection.contributionCalendar.weeks.map(week => week.contributionDays.map(day => day.contributionCount)));
  const { streak } = days
    .reverse()
    // streak = count consecutive commits backwards from today
    .reduce(({ streak, end }, commits, index) => commits == 0 || end ? { streak, end: index > 0 } : { streak: streak + 1, end },
      { streak: 0, end: false });

  return {
    name: data.viewer.login,
    avatar_url: data.viewer.avatarUrl,
    streak,
  }
}

async function updateUsers() {
  const accessTokens = await knex('users').select('access_token');
  console.log('updating streaks for ' + accessTokens.length + ' users');
  await Promise.all(accessTokens.map(async ({ access_token }) => {
    try {
      await knex('users')
        .update(await getProfileData(access_token))
        .where('access_token', access_token)
    } catch (error) {
      console.error(error);
    }
  }));
}

// frontend redirects to this URL.
// redirect the user to the GitHub login screen
router.get('/auth/github', passport.authenticate('oauth2'));

// then, GitHub redirects to this URL
router.get('/auth/github/callback',
  // set a cookie
  passport.authenticate('oauth2', {
    // redirect the user back to the frontend
    successRedirect: FRONTEND_URL,
    failureRedirect: FRONTEND_URL,
  }));

// clear the cookie
router.post('/logout', async ctx => {
  ctx.logout();
  ctx.body = '';
});

router.get('/user', async ctx => {
  if (ctx.isUnauthenticated()) {
    return ctx.throw(403);
  }

  const name = ctx.state.user;
  const [ user ] = await knex('users')
    .select('name', 'story', 'kudos', 'streak', 'avatar_url')
    .where('name', name);
  ctx.body = user;
});

router.patch('/user', async ctx => {
  if (ctx.isUnauthenticated()) {
    return ctx.throw(403);
  }

  const changes = {};
  if ('story' in ctx.request.body && ctx.request.body.story.length <= 280) {
    changes.story = ctx.request.body.story;
  }

  const name = ctx.state.user;
  await knex('users')
    .update(changes)
    .where('name', name);

  ctx.body = await knex('users')
    .select('name', 'story', 'kudos', 'streak', 'avatar_url')
    .where('name', name);
  console.log('updated ' + name);
});

router.delete('/user', async ctx => {
  if (ctx.isUnauthenticated()) {
    return ctx.throw(403);
  }

  const name = ctx.state.user;
  await knex('users')
    .delete()
    .where('name', name);
  ctx.logout();
  ctx.body = '';
});

router.post('/users/:user/kudos', async ctx => {
  const name = ctx.params.user;
  await knex('users')
    .where('name', name)
    .increment('kudos', 1);
  const [{ kudos }] = await knex('users')
    .select('kudos')
    .where('name', name);
  ctx.body = kudos;
  console.log('gave a kudo to ' + name);
});

router.get('/feed', async ctx => {
  const { size = 10, page = 0 } = ctx.query;
  ctx.body = await knex('users')
    .select('name', 'story', 'kudos', 'streak','avatar_url')
    .orderBy('created_at', 'desc')
    .limit(Math.min(100, size))
    .offset(size * page);
});

app.use(router.routes());
app.use(router.allowedMethods());

async function startup() {
  if (!await knex.schema.hasTable('users')) {
    await knex.schema.createTable('users', (table) => {
      table.string('name').notNullable().primary();
      table.string('avatar_url').notNullable();
      table.string('access_token').notNullable();
      table.integer('streak').unsigned().notNullable();
      table.text('story').notNullable();
      table.bigInteger('kudos').notNullable();
      table.timestamps();
    });
  }

  cron.schedule('0 * * * *', updateUsers); // every hour
  app.listen(PORT || 3001, () => console.log(`Server running on http://localhost:${PORT}/`));
}

startup().catch(console.error);

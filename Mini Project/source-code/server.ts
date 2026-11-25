import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import {
  getCustomers,
  getCustomerById,
  getCustomerByEmail,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getInteractions,
  getCustomerInteractions,
  createInteraction,
  deleteInteraction,
  getFollowups,
  getCustomerFollowups,
  createFollowup,
  updateFollowup,
  toggleFollowupStatus,
  deleteFollowup,
  getDashboardData,
  getReportsData,
  getSettings,
  updateSettings,
  resetDatabase,
  getUserCount,
  getUserByEmail,
  getUserById,
  listUsers,
  createUser,
  updateUserPassword,
  getSessionSecret,
  IntegrityError,
  User,
  UserRole
} from './src/models.js';
import { FileSessionStore } from './src/sessionStore.js';
import {
  runCrmAssistantTurn,
  AssistantMode,
  AssistantSpeed,
  ChatTurn,
  AiServiceError
} from './src/aiAssistant.js';
import { runLocalCrmAssistantTurn } from './src/localAssistant.js';

declare module 'express-session' {
  interface SessionData {
    flash?: { category: string; message: string }[];
    userId?: number;
    _csrf_token?: string;
    aiChatHistory?: ChatTurn[];
  }
}

interface RequestWithContext extends Request {
  flash?: (category: string, message: string) => void;
  currentUser?: User;
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

function parseId(param: string | string[] | undefined): number {
  if (Array.isArray(param)) return parseInt(param[0], 10);
  return parseInt(param || '0', 10);
}

function validPassword(password: string): boolean {
  return typeof password === 'string' && password.length >= 12;
}

function safeRedirectTarget(referrer: string | undefined, fallback: string): string {
  if (!referrer) return fallback;
  try {
    const parsed = new URL(referrer, 'http://localhost');
    if (parsed.origin === 'http://localhost') {
      return parsed.pathname + parsed.search;
    }
  } catch {
    // ignore invalid URL
  }
  return fallback;
}

function isHttpsRequest(req: Request): boolean {
  if (process.env.COOKIE_SECURE === '1') return true;
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (req.secure || forwardedProto === 'https') return true;
  const forwarded = String(req.get('forwarded') || '').toLowerCase();
  if (forwarded.includes('proto=https')) return true;
  if (String(req.get('x-forwarded-ssl') || '').toLowerCase() === 'on') return true;
  const origin = String(req.get('origin') || '').toLowerCase();
  if (origin.startsWith('https://')) return true;
  const referer = String(req.get('referer') || '').toLowerCase();
  if (referer.startsWith('https://')) return true;
  const host = String(req.get('host') || '').toLowerCase().split(':')[0];
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim().toLowerCase().split(':')[0];
  for (const h of [host, forwardedHost]) {
    if (h.endsWith('.run.app') || h.endsWith('.aistudio.google.com') || h.endsWith('.googleusercontent.com')) {
      return true;
    }
  }
  const secFetchDest = String(req.get('sec-fetch-dest') || '').toLowerCase();
  if (secFetchDest === 'iframe' && host !== 'localhost' && host !== '127.0.0.1') {
    return true;
  }
  return false;
}

const DISALLOWED_NEXT_PREFIXES = [
  '/login',
  '/setup-admin',
  '/logout',
  '/favicon.ico',
  '/robots.txt',
  '/static/',
  '/api/',
  '/.well-known/',
  '/customers/add',
  '/customers/edit/',
  '/customers/delete/',
  '/interactions/add',
  '/interactions/delete/',
  '/followups/add',
  '/followups/edit/',
  '/followups/toggle/',
  '/followups/delete/',
  '/admin/',
  '/reset-database'
];

function safeNextTarget(raw: unknown, fallback = '/dashboard'): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  if (trimmed === '/') return fallback || '/dashboard';
  const pathnameOnly = trimmed.split('?')[0].toLowerCase();
  if (DISALLOWED_NEXT_PREFIXES.some(prefix => pathnameOnly.startsWith(prefix))) {
    return fallback;
  }
  return trimmed;
}

const sessionStore = new FileSessionStore();

function appendPartitionedAttribute(cookieVal: string): string {
  if (/;\s*partitioned\b/i.test(cookieVal)) return cookieVal;
  return `${cookieVal}; Partitioned`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveAppDir(subdir: string): string {
  const candidates = [
    path.join(process.cwd(), subdir),
    path.join(__dirname, subdir),
    path.resolve(__dirname, '..', subdir)
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
}

const viewsDir = resolveAppDir('views');
const publicDir = resolveAppDir('public');

// View engine setup
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', viewsDir);

// Static assets & favicon (mounted BEFORE session/auth so parallel asset loads never race cookies)
app.get('/favicon.ico', (_req: Request, res: Response) => {
  res.status(204).end();
});
app.use('/static/css', express.static(path.join(publicDir, 'css')));
app.use('/static/js', express.static(path.join(publicDir, 'js')));
app.use(express.static(publicDir));

// Normalize HTTPS proxy headers and append Partitioned cookie attribute for cross-origin iframes
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!isHttpsRequest(req)) return next();

  // Ensure express-session's internal issecure() recognizes proxied HTTPS
  req.headers['x-forwarded-proto'] = 'https';

  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (
    this: Response,
    statusCode: number,
    reasonOrHeaders?: string | Record<string, number | string | string[] | undefined>,
    maybeHeaders?: Record<string, number | string | string[] | undefined>
  ) {
    const existing = res.getHeader('Set-Cookie');
    if (existing) {
      const list = Array.isArray(existing) ? existing.map(String) : [String(existing)];
      res.setHeader(
        'Set-Cookie',
        list.map(c => (c.startsWith('connect.sid=') ? appendPartitionedAttribute(c) : c))
      );
    }
    if (typeof reasonOrHeaders === 'string') {
      if (maybeHeaders !== undefined) {
        return origWriteHead(statusCode, reasonOrHeaders, maybeHeaders);
      }
      return origWriteHead(statusCode, reasonOrHeaders);
    }
    if (reasonOrHeaders !== undefined) {
      return origWriteHead(statusCode, reasonOrHeaders);
    }
    return origWriteHead(statusCode);
  } as typeof res.writeHead;

  next();
});

// Body parsing and sessions
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    store: sessionStore,
    secret: getSessionSecret(),
    proxy: true,
    rolling: true,
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);
app.use((req: Request, _res: Response, next: NextFunction) => {
  const isHttps = isHttpsRequest(req);
  req.session.cookie.secure = isHttps;
  req.session.cookie.sameSite = isHttps ? 'none' : 'lax';
  next();
});

// Template filters and helpers
app.locals.badgeColor = function (status: string | undefined): string {
  const map: Record<string, string> = {
    active: 'badge-active',
    inactive: 'badge-inactive',
    pending: 'badge-pending',
    completed: 'badge-completed',
    high: 'badge-high',
    medium: 'badge-medium',
    low: 'badge-low'
  };
  return map[String(status || '').toLowerCase()] || 'badge-default';
};

app.locals.getInitials = function (name: string | undefined): string {
  if (!name) return 'CR';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
};

app.locals.capitalize = function (val: string | undefined): string {
  if (!val) return '';
  return val.charAt(0).toUpperCase() + val.slice(1);
};

// Flash, CSRF, and Authentication / Authorization Middleware
app.use((req: RequestWithContext, res: Response, next: NextFunction) => {
  if (!req.session._csrf_token) {
    req.session._csrf_token = crypto.randomBytes(24).toString('base64url');
  }
  const csrfToken = req.session._csrf_token;

  res.locals.csrfToken = csrfToken;
  res.locals.flashMessages = req.session.flash || [];
  req.session.flash = [];
  res.locals.settings = getSettings();
  res.locals.currentUser = null;

  req.flash = (category: string, message: string) => {
    if (!req.session.flash) req.session.flash = [];
    req.session.flash.push({ category, message });
  };

  if (req.method === 'POST') {
    const supplied = String(req.body?._csrf_token || req.get('X-CSRF-Token') || '');
    const expectedBuf = Buffer.from(csrfToken, 'utf8');
    const suppliedBuf = Buffer.from(supplied, 'utf8');
    if (
      !csrfToken ||
      expectedBuf.length !== suppliedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, suppliedBuf)
    ) {
      if (req.path.startsWith('/api/')) {
        return res.status(400).json({ error: 'Invalid or expired form session token. Please refresh the page.' });
      }
      if (req.path === '/login' || req.path === '/setup-admin') {
        const isSetup = req.path === '/setup-admin' && getUserCount() === 0;
        const nextUrl = safeNextTarget(req.body?.next || req.query.next, '');
        return res.status(400).render('login', {
          setupRequired: isSetup,
          noUsersYet: getUserCount() === 0,
          nextUrl,
          flashMessages: [
            {
              category: 'danger',
              message: 'Your session expired or was reset. Please submit the form again.'
            }
          ]
        });
      }
      return res.status(400).send(
        '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Session Expired - CRM</title><link rel="stylesheet" href="/static/css/style.css"></head><body><main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#f1f5f9;"><section class="card" style="width:min(100%,460px);"><div class="card-header"><div class="card-title">Session Verification Failed</div></div><div class="card-body"><div class="alert alert-danger">Invalid or expired form session token.</div><a class="btn btn-primary" href="/dashboard">Return to Dashboard</a></div></section></main></body></html>'
      );
    }
  }

  const reqPath = req.path;
  if (reqPath === '/login' || reqPath === '/setup-admin') {
    const existingUser = req.session.userId ? getUserById(req.session.userId) : undefined;
    if (existingUser && (req.method === 'GET' || reqPath === '/setup-admin')) {
      if (existingUser.must_change_password) {
        return res.redirect('/change-password');
      }
      if (existingUser.role === 'customer') {
        if (!existingUser.customer_id) return res.status(403).send('Forbidden');
        return res.redirect(`/my-account/${existingUser.customer_id}`);
      }
      return res.redirect(safeNextTarget(req.query.next || req.body?.next, '/dashboard'));
    }
    if (reqPath === '/setup-admin' && getUserCount() > 0) {
      const nextParam = safeNextTarget(req.query.next || req.body?.next, '');
      return res.redirect(nextParam ? `/login?next=${encodeURIComponent(nextParam)}` : '/login');
    }
    return next();
  }

  const userId = req.session.userId;
  if (!userId) {
    if (reqPath.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }
    const requested = safeNextTarget(req.originalUrl, '/dashboard');
    if (getUserCount() === 0) {
      return res.redirect(`/setup-admin?next=${encodeURIComponent(requested)}`);
    }
    return res.redirect(`/login?next=${encodeURIComponent(requested)}`);
  }

  const user = getUserById(userId);
  if (!user) {
    delete req.session.userId;
    if (reqPath.startsWith('/api/')) {
      return req.session.save(() => res.status(401).json({ error: 'Session expired. Please sign in again.' }));
    }
    const requested = safeNextTarget(req.originalUrl, '/dashboard');
    if (getUserCount() === 0) {
      return req.session.save(() => res.redirect(`/setup-admin?next=${encodeURIComponent(requested)}`));
    }
    return req.session.save(() => res.redirect(`/login?next=${encodeURIComponent(requested)}`));
  }

  req.currentUser = user;
  res.locals.currentUser = user;

  if (user.must_change_password && reqPath !== '/change-password' && reqPath !== '/logout') {
    if (reqPath.startsWith('/api/')) {
      return res.status(400).json({ error: 'Please update your temporary password before using the API.' });
    }
    return res.redirect('/change-password');
  }

  const isAdminOnly =
    reqPath === '/settings' ||
    reqPath === '/reset-database' ||
    reqPath === '/download-customers.xlsx' ||
    reqPath === '/settings/export-customers' ||
    reqPath === '/admin/users' ||
    reqPath === '/api/ai/approve-followup' ||
    /^\/admin\/users\/\d+\/reset-password$/.test(reqPath);

  if (isAdminOnly && user.role !== 'admin') {
    if (reqPath.startsWith('/api/')) {
      return res.status(400).json({ error: 'Admin approval is required for this action.' });
    }
    return res.status(403).send('Forbidden');
  }

  if (user.role === 'customer') {
    if (reqPath === '/') {
      if (!user.customer_id) return res.status(403).send('Forbidden');
      return res.redirect(`/my-account/${user.customer_id}`);
    }
    const portalMatch = reqPath.match(/^\/my-account\/(\d+)$/);
    if (portalMatch && user.customer_id === parseInt(portalMatch[1], 10)) {
      return next();
    }
    if (reqPath === '/change-password' || reqPath === '/logout') {
      return next();
    }
    if (reqPath.startsWith('/api/')) {
      return res.status(400).json({ error: 'This workspace action is only available to CRM staff.' });
    }
    return res.status(403).send('Forbidden');
  }

  next();
});

function validateCustomerForm(name: string, email: string, phone: string): string | null {
  if (!name || name.trim().length < 2) {
    return 'Customer full name is required (minimum 2 characters).';
  }
  const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  if (!email || !emailPattern.test(email.trim())) {
    return 'Please enter a valid email address (e.g., name@example.com).';
  }
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length < 7) {
    return 'Please enter a valid phone number (at least 7 digits).';
  }
  return null;
}

// ---------------------------------------------------------------------------
// AUTHENTICATION & USER ACCOUNTS
// ---------------------------------------------------------------------------
app.get('/login', (req: RequestWithContext, res: Response) => {
  const nextUrl = safeNextTarget(req.query.next, '');
  res.render('login', {
    setupRequired: false,
    noUsersYet: getUserCount() === 0,
    nextUrl
  });
});

app.post('/login', (req: RequestWithContext, res: Response) => {
  const nextParam = safeNextTarget(req.body.next || req.query.next, '');
  const loginFailRedirect = nextParam ? `/login?next=${encodeURIComponent(nextParam)}` : '/login';

  if (getUserCount() === 0) {
    req.flash?.('danger', 'No accounts exist yet. Create the first admin account first.');
    return req.session.save(() => res.redirect(loginFailRedirect));
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = getUserByEmail(email);

  if (user && bcrypt.compareSync(password, user.password_hash)) {
    req.session.userId = user.id;
    req.session._csrf_token = crypto.randomBytes(24).toString('base64url');
    let destination = '/dashboard';
    if (user.must_change_password) {
      destination = '/change-password';
    } else if (user.role === 'customer') {
      destination = user.customer_id ? `/my-account/${user.customer_id}` : '/change-password';
    } else {
      destination = safeNextTarget(req.body.next || req.query.next, '/dashboard');
    }
    return req.session.save(() => res.redirect(destination));
  }

  req.flash?.('danger', 'Email or password was not recognized.');
  return req.session.save(() => res.redirect(loginFailRedirect));
});

app.get('/setup-admin', (req: RequestWithContext, res: Response) => {
  const nextUrl = safeNextTarget(req.query.next, '');
  if (getUserCount() > 0) {
    return res.redirect(nextUrl ? `/login?next=${encodeURIComponent(nextUrl)}` : '/login');
  }
  res.render('login', { setupRequired: true, noUsersYet: true, nextUrl });
});

app.post('/setup-admin', (req: RequestWithContext, res: Response) => {
  const nextParam = safeNextTarget(req.body.next || req.query.next, '');
  if (getUserCount() > 0) {
    req.flash?.('info', 'An admin account already exists. Please sign in.');
    return req.session.save(() =>
      res.redirect(nextParam ? `/login?next=${encodeURIComponent(nextParam)}` : '/login')
    );
  }
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirmation = String(req.body.confirm_password || '');
  const setupRetryUrl = nextParam ? `/setup-admin?next=${encodeURIComponent(nextParam)}` : '/setup-admin';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    req.flash?.('danger', 'Enter a valid email address.');
    return req.session.save(() => res.redirect(setupRetryUrl));
  }
  if (!validPassword(password)) {
    req.flash?.('danger', 'Use a password with at least 12 characters.');
    return req.session.save(() => res.redirect(setupRetryUrl));
  }
  if (password !== confirmation) {
    req.flash?.('danger', 'The passwords do not match.');
    return req.session.save(() => res.redirect(setupRetryUrl));
  }

  const hash = bcrypt.hashSync(password, 10);
  const newUserId = createUser(email, hash, 'admin');
  req.session.userId = newUserId;
  req.session._csrf_token = crypto.randomBytes(24).toString('base64url');
  req.flash?.('success', 'Admin account created and signed in.');
  return req.session.save(() => res.redirect(nextParam || '/dashboard'));
});

app.post('/logout', (req: RequestWithContext, res: Response) => {
  delete req.session.userId;
  req.session._csrf_token = crypto.randomBytes(24).toString('base64url');
  req.flash?.('info', 'You have been signed out.');
  req.session.save(() => res.redirect('/login'));
});

app.get('/change-password', (req: RequestWithContext, res: Response) => {
  res.render('change_password');
});

app.post('/change-password', (req: RequestWithContext, res: Response) => {
  const user = req.currentUser!;
  const currentPassword = String(req.body.current_password || '');
  const newPassword = String(req.body.new_password || '');
  const confirmation = String(req.body.confirm_password || '');

  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    req.flash?.('danger', 'Current password is incorrect.');
    return res.redirect('/change-password');
  }
  if (!validPassword(newPassword)) {
    req.flash?.('danger', 'Use a password with at least 12 characters.');
    return res.redirect('/change-password');
  }
  if (newPassword !== confirmation) {
    req.flash?.('danger', 'The new passwords do not match.');
    return res.redirect('/change-password');
  }

  updateUserPassword(user.id, bcrypt.hashSync(newPassword, 10), false);
  req.flash?.('success', 'Password updated successfully.');
  res.redirect('/');
});

app.post('/admin/users', (req: RequestWithContext, res: Response) => {
  let email = String(req.body.email || '').trim().toLowerCase();
  const role = String(req.body.role || '').trim() as UserRole;
  const password = String(req.body.password || '');
  let customerId: number | null = null;

  if (role === 'customer') {
    const customer = getCustomerByEmail(String(req.body.customer_email || '').trim());
    if (!customer) {
      req.flash?.('danger', "For a customer account, use an existing customer's email.");
      return res.redirect('/settings');
    }
    customerId = customer.id;
    email = customer.email.toLowerCase();
  }

  if (!['admin', 'staff', 'customer'].includes(role) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    req.flash?.('danger', 'Select a valid role and enter a valid email address.');
    return res.redirect('/settings');
  }
  if (!validPassword(password)) {
    req.flash?.('danger', 'Temporary passwords must have at least 12 characters.');
    return res.redirect('/settings');
  }

  try {
    createUser(email, bcrypt.hashSync(password, 10), role, customerId, true);
    req.flash?.('success', 'Account created. The user must change the temporary password at sign-in.');
  } catch (err) {
    if (err instanceof IntegrityError) {
      req.flash?.('danger', 'That email or customer profile already has an account.');
    } else {
      throw err;
    }
  }
  res.redirect('/settings');
});

app.post('/admin/users/:id/reset-password', (req: RequestWithContext, res: Response) => {
  const userId = parseId(req.params.id);
  const user = getUserById(userId);
  const password = String(req.body.password || '');

  if (!user) {
    return res.status(404).send('User not found');
  }
  if (!validPassword(password)) {
    req.flash?.('danger', 'Temporary passwords must have at least 12 characters.');
  } else {
    updateUserPassword(userId, bcrypt.hashSync(password, 10), true);
    req.flash?.('success', 'Password reset. The user must change it at next sign-in.');
  }
  res.redirect('/settings');
});

// ---------------------------------------------------------------------------
// DASHBOARD & CUSTOMER PORTAL
// ---------------------------------------------------------------------------
app.get('/', (req: Request, res: Response) => {
  res.redirect('/dashboard');
});

app.get('/dashboard', (req: Request, res: Response) => {
  const data = getDashboardData();
  const settings = getSettings();
  res.render('dashboard', { data, settings });
});

app.get('/my-account/:id', (req: Request, res: Response) => {
  const customerId = parseId(req.params.id);
  const customer = getCustomerById(customerId);
  if (!customer) {
    return res.status(404).send('Customer not found');
  }
  res.render('customer_portal', {
    customer,
    interactions: getCustomerInteractions(customerId),
    followups: getCustomerFollowups(customerId),
    settings: getSettings()
  });
});

// ---------------------------------------------------------------------------
// CUSTOMERS CRUD
// ---------------------------------------------------------------------------
app.get('/customers', (req: Request, res: Response) => {
  const searchQuery = String(req.query.search || '').trim();
  const statusFilter = String(req.query.status || 'All').trim();
  const customers = getCustomers(searchQuery, statusFilter);
  const settings = getSettings();

  res.render('customers', {
    customers,
    searchQuery,
    statusFilter,
    settings
  });
});

app.post('/customers/add', (req: RequestWithContext, res: Response) => {
  const { name, email, phone, company, address, status, notes } = req.body;
  const error = validateCustomerForm(name, email, phone);
  if (error) {
    req.flash?.('danger', error);
    return res.redirect('/customers');
  }

  const validStatus = ['Active', 'Inactive', 'Pending'].includes(status) ? status : 'Active';
  const newId = createCustomer(name, email, phone, company || '', address || '', validStatus, notes || '');
  req.flash?.('success', `Customer '${name.trim()}' added successfully! (ID: #CUST-${newId})`);
  res.redirect('/customers');
});

app.get('/customers/:id', (req: RequestWithContext, res: Response) => {
  const customerId = parseId(req.params.id);
  const customer = getCustomerById(customerId);

  if (!customer) {
    req.flash?.('warning', `Customer ID #${customerId} was not found.`);
    return res.redirect('/customers');
  }

  const interactions = getCustomerInteractions(customerId);
  const followups = getCustomerFollowups(customerId);
  const settings = getSettings();

  res.render('customer_details', {
    customer,
    interactions,
    followups,
    settings
  });
});

app.post('/customers/edit/:id', (req: RequestWithContext, res: Response) => {
  const customerId = parseId(req.params.id);
  const { name, email, phone, company, address, status, notes } = req.body;

  const error = validateCustomerForm(name, email, phone);
  const backUrl = safeRedirectTarget(req.get('Referrer'), `/customers/${customerId}`);
  if (error) {
    req.flash?.('danger', error);
    return res.redirect(backUrl);
  }

  const validStatus = ['Active', 'Inactive', 'Pending'].includes(status) ? status : 'Active';
  updateCustomer(customerId, name, email, phone, company || '', address || '', validStatus, notes || '');
  req.flash?.('success', `Customer details for '${name.trim()}' updated successfully.`);
  res.redirect(backUrl);
});

app.post('/customers/delete/:id', (req: RequestWithContext, res: Response) => {
  const customerId = parseId(req.params.id);
  const customer = getCustomerById(customerId);
  const custName = customer ? customer.name : `#${customerId}`;

  deleteCustomer(customerId);
  req.flash?.('info', `Customer '${custName}' deleted.`);
  res.redirect('/customers');
});

// ---------------------------------------------------------------------------
// INTERACTIONS
// ---------------------------------------------------------------------------
app.get('/interactions', (req: Request, res: Response) => {
  const typeFilter = String(req.query.type || 'All').trim();
  const interactions = getInteractions(typeFilter);
  const customers = getCustomers();
  const settings = getSettings();

  res.render('interactions', {
    interactions,
    typeFilter,
    customers,
    settings
  });
});

app.post('/interactions/add', (req: RequestWithContext, res: Response) => {
  const { customer_id, type, description, interaction_date, follow_up_date } = req.body;
  const backUrl = safeRedirectTarget(req.get('Referrer'), '/interactions');

  if (!customer_id) {
    req.flash?.('danger', 'Please select a valid customer.');
    return res.redirect(backUrl);
  }
  if (!description || !String(description).trim()) {
    req.flash?.('danger', 'Please provide brief notes/description for the interaction.');
    return res.redirect(backUrl);
  }

  const validTypes = ['Call', 'Email', 'Meeting', 'WhatsApp', 'Other'];
  const interType = validTypes.includes(type) ? type : 'Call';

  createInteraction(
    parseInt(String(customer_id), 10),
    interType,
    String(description),
    interaction_date || undefined,
    follow_up_date || null
  );

  req.flash?.('success', 'Interaction logged successfully.');
  res.redirect(backUrl);
});

app.post('/interactions/delete/:id', (req: RequestWithContext, res: Response) => {
  const interactionId = parseId(req.params.id);
  deleteInteraction(interactionId);
  req.flash?.('info', 'Interaction deleted.');
  res.redirect(safeRedirectTarget(req.get('Referrer'), '/interactions'));
});

// ---------------------------------------------------------------------------
// FOLLOW-UPS
// ---------------------------------------------------------------------------
app.get('/followups', (req: Request, res: Response) => {
  const statusFilter = String(req.query.status || 'All').trim();
  const followups = getFollowups(statusFilter);
  const customers = getCustomers();
  const settings = getSettings();

  res.render('followups', {
    followups,
    statusFilter,
    customers,
    settings
  });
});

app.post('/followups/add', (req: RequestWithContext, res: Response) => {
  const { customer_id, reason, follow_up_date, priority } = req.body;
  const backUrl = safeRedirectTarget(req.get('Referrer'), '/followups');

  if (!customer_id) {
    req.flash?.('danger', 'Please select a customer for this follow-up.');
    return res.redirect(backUrl);
  }
  if (!reason || !String(reason).trim()) {
    req.flash?.('danger', 'Follow-up reason cannot be empty.');
    return res.redirect(backUrl);
  }
  if (!follow_up_date) {
    req.flash?.('danger', 'Please select a scheduled follow-up date.');
    return res.redirect(backUrl);
  }

  const validPriority = ['Low', 'Medium', 'High'].includes(priority) ? priority : 'Medium';
  createFollowup(parseInt(String(customer_id), 10), String(reason), String(follow_up_date), validPriority, 'Pending');
  req.flash?.('success', 'Follow-up task scheduled successfully.');
  res.redirect(backUrl);
});

app.post('/followups/edit/:id', (req: RequestWithContext, res: Response) => {
  const followupId = parseId(req.params.id);
  const { reason, follow_up_date, priority, status } = req.body;
  const backUrl = safeRedirectTarget(req.get('Referrer'), '/followups');

  if (!reason || !follow_up_date) {
    req.flash?.('danger', 'Reason and date are required.');
    return res.redirect(backUrl);
  }

  const validPriority = ['Low', 'Medium', 'High'].includes(priority) ? priority : 'Medium';
  const validStatus = ['Pending', 'Completed'].includes(status) ? status : 'Pending';

  updateFollowup(followupId, String(reason), String(follow_up_date), validPriority, validStatus);
  req.flash?.('success', 'Follow-up updated successfully.');
  res.redirect(backUrl);
});

app.post('/followups/toggle/:id', (req: RequestWithContext, res: Response) => {
  const followupId = parseId(req.params.id);
  const newStatus = toggleFollowupStatus(followupId);
  if (newStatus) {
    req.flash?.('success', `Follow-up marked as ${newStatus}!`);
  }
  res.redirect(safeRedirectTarget(req.get('Referrer'), '/followups'));
});

app.post('/followups/delete/:id', (req: RequestWithContext, res: Response) => {
  const followupId = parseId(req.params.id);
  deleteFollowup(followupId);
  req.flash?.('info', 'Follow-up deleted.');
  res.redirect(safeRedirectTarget(req.get('Referrer'), '/followups'));
});

// ---------------------------------------------------------------------------
// REPORTS & ANALYTICS
// ---------------------------------------------------------------------------
app.get('/reports', (req: Request, res: Response) => {
  const reportsData = getReportsData();
  const settings = getSettings();
  res.render('reports', { reports: reportsData, settings });
});

app.get('/api/reports-data', (req: Request, res: Response) => {
  res.json(getReportsData());
});

// ---------------------------------------------------------------------------
// AI CRM ASSISTANT (GEMINI)
// ---------------------------------------------------------------------------
const VALID_AI_MODES: AssistantMode[] = [
  'general',
  'insights',
  'message',
  'followups',
  'analytics',
  'history'
];

app.get('/ai-assistant', (req: RequestWithContext, res: Response) => {
  const customers = getCustomers();
  const initialCustomerId = req.query.customerId ? parseInt(String(req.query.customerId), 10) : null;
  const rawMode = String(req.query.mode || 'general') as AssistantMode;
  const initialMode = VALID_AI_MODES.includes(rawMode) ? rawMode : 'general';
  const initialPrompt = String(req.query.prompt || '').slice(0, 500);

  res.render('ai_assistant', {
    customers,
    history: req.session.aiChatHistory || [],
    initialCustomerId: Number.isInteger(initialCustomerId) ? initialCustomerId : null,
    initialMode,
    initialPrompt,
    settings: getSettings()
  });
});

app.get('/api/ai/history', (req: Request, res: Response) => {
  const customers = getCustomers().map(c => ({
    id: c.id,
    name: c.name,
    company: c.company || '',
    status: c.status
  }));
  res.json({
    history: req.session.aiChatHistory || [],
    customers
  });
});

app.post('/api/ai/chat', async (req: RequestWithContext, res: Response) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) {
      return res.status(400).json({ error: 'Please enter a message or question for the CRM assistant.' });
    }
    const rawMode = String(req.body?.mode || 'general') as AssistantMode;
    const mode: AssistantMode = VALID_AI_MODES.includes(rawMode) ? rawMode : 'general';
    const rawSpeed = String(req.body?.speed || 'local');
    const rawCustomerId = req.body?.customerId ? parseInt(String(req.body.customerId), 10) : null;
    const customerId = rawCustomerId && Number.isInteger(rawCustomerId) ? rawCustomerId : null;
    const tone = req.body?.tone ? String(req.body.tone).trim() : undefined;
    const channel = req.body?.channel ? String(req.body.channel).trim() : undefined;

    const history = Array.isArray(req.session.aiChatHistory) ? [...req.session.aiChatHistory] : [];

    const result =
      rawSpeed === 'local'
        ? runLocalCrmAssistantTurn({
            message,
            history,
            mode,
            customerId,
            tone,
            channel
          })
        : await runCrmAssistantTurn({
            message,
            history,
            mode,
            speed: (rawSpeed === 'fast' ? 'fast' : 'standard') as AssistantSpeed,
            customerId,
            tone,
            channel
          });

    const nowIso = new Date().toISOString();
    const userTurn: ChatTurn = {
      role: 'user',
      text: message,
      mode,
      timestamp: nowIso
    };
    const modelTurn: ChatTurn = {
      role: 'model',
      text: result.reply,
      mode,
      draftMessage: result.draftMessage,
      suggestedFollowups: result.suggestedFollowups,
      timestamp: nowIso
    };

    const updatedHistory = [...history, userTurn, modelTurn].slice(-40);
    req.session.aiChatHistory = updatedHistory;

    return req.session.save((saveErr) => {
      if (saveErr) console.error('AI chat session save error:', saveErr);
      return res.json({
        history: updatedHistory,
        lastTurn: modelTurn,
        modelUsed: result.modelUsed
      });
    });
  } catch (err) {
    if (err instanceof AiServiceError) {
      const safeStatus = [403, 502, 503, 504].includes(err.statusCode) ? 500 : err.statusCode;
      return res.status(safeStatus).json({ error: err.message });
    }
    console.error('AI chat error:', err);
    return res.status(500).json({ error: 'Unable to process AI assistant request.' });
  }
});

app.post('/api/ai/clear', (req: Request, res: Response) => {
  req.session.aiChatHistory = [];
  req.session.save((saveErr) => {
    if (saveErr) console.error('AI clear session save error:', saveErr);
    res.json({ ok: true, history: [] });
  });
});

app.post('/api/ai/approve-followup', (req: RequestWithContext, res: Response) => {
  const customerId = parseInt(String(req.body?.customerId || '0'), 10);
  const reason = String(req.body?.reason || '').trim();
  const followUpDate = String(req.body?.followUpDate || '').trim();
  const rawPriority = String(req.body?.priority || 'Medium').trim();

  const customer = Number.isInteger(customerId) ? getCustomerById(customerId) : undefined;
  if (!customer) {
    return res.status(400).json({ error: 'Please select a valid existing customer.' });
  }
  if (!reason) {
    return res.status(400).json({ error: 'Follow-up reason is required.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(followUpDate)) {
    return res.status(400).json({ error: 'A valid follow-up date (YYYY-MM-DD) is required.' });
  }
  const priority: 'Low' | 'Medium' | 'High' =
    rawPriority === 'High' || rawPriority === 'Low' ? rawPriority : 'Medium';

  const followupId = createFollowup(customer.id, reason, followUpDate, priority, 'Pending');
  return res.json({
    ok: true,
    followupId,
    message: `Follow-up created for ${customer.name} on ${followUpDate} (${priority} priority).`
  });
});

// ---------------------------------------------------------------------------
// SETTINGS, EXCEL EXPORT & DATABASE RESET
// ---------------------------------------------------------------------------
app.get('/settings', (req: Request, res: Response) => {
  const settings = getSettings();
  res.render('settings', { settings, users: listUsers() });
});

app.post('/settings', (req: RequestWithContext, res: Response) => {
  const { business_name, owner_email, owner_phone, currency, theme } = req.body;
  const allowedTheme = theme === 'dark' || theme === 'indigo' ? theme : 'light';
  updateSettings(
    business_name || 'CRM',
    owner_email || 'admin@crm.local',
    owner_phone || '+91 98765 43210',
    currency || '₹',
    allowedTheme
  );
  req.flash?.('success', 'Settings saved successfully.');
  res.redirect('/settings');
});

app.post('/api/theme', (req: RequestWithContext, res: Response) => {
  const rawTheme = String(req.body?.theme || 'light');
  const nextTheme = rawTheme === 'dark' || rawTheme === 'indigo' ? rawTheme : 'light';
  if (req.currentUser?.role === 'admin') {
    const cur = getSettings();
    updateSettings(cur.business_name, cur.owner_email, cur.owner_phone, cur.currency, nextTheme);
  }
  res.json({ ok: true, theme: nextTheme });
});

app.get(['/download-customers.xlsx', '/settings/export-customers'], async (req: Request, res: Response) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Customers', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  sheet.columns = [
    { header: 'ID', key: 'id', width: 10 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Phone', key: 'phone', width: 18 },
    { header: 'Company', key: 'company', width: 24 },
    { header: 'Address', key: 'address', width: 30 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Notes', key: 'notes', width: 40 },
    { header: 'Created At', key: 'created_at', width: 16 },
    { header: 'Last Contact', key: 'last_contact', width: 16 }
  ];

  sheet.getRow(1).font = { bold: true };

  const sanitize = (value: string | number) => {
    if (typeof value === 'string' && /^[=+\-@]/.test(value)) {
      return `'${value}`;
    }
    return value;
  };

  for (const customer of getCustomers()) {
    sheet.addRow({
      id: customer.id,
      name: sanitize(customer.name),
      email: sanitize(customer.email),
      phone: sanitize(customer.phone),
      company: sanitize(customer.company),
      address: sanitize(customer.address),
      status: sanitize(customer.status),
      notes: sanitize(customer.notes),
      created_at: sanitize(customer.created_at),
      last_contact: sanitize(customer.last_contact)
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const today = new Date().toISOString().slice(0, 10);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="customers_${today}.xlsx"`
  });
  res.send(Buffer.from(buffer));
});

app.post('/reset-database', (req: RequestWithContext, res: Response) => {
  resetDatabase();
  req.flash?.('info', 'Database successfully reset to initial realistic sample data!');
  res.redirect('/dashboard');
});

// Styled 404 fallback so authenticated users never land on a bare empty page
app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({ error: 'Requested API endpoint was not found.' });
  }
  res.status(404).send(
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Page Not Found - CRM</title><link rel="stylesheet" href="/static/css/style.css"></head><body><main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#f1f5f9;"><section class="card" style="width:min(100%,460px);"><div class="card-header"><div class="card-title">Page Not Found</div></div><div class="card-body"><p style="color:#475569;margin-bottom:16px;">The requested page could not be found.</p><a class="btn btn-primary" href="/dashboard">Go to Dashboard</a></div></section></main></body></html>'
  );
});

// Fallback error handler to avoid silent blank screens or non-JSON API responses
app.use((err: Error & { type?: string; status?: number }, req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled request error:', err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
    if (err.type === 'entity.parse.failed' || err.status === 400) {
      return res.status(400).json({ error: 'Invalid JSON request body.' });
    }
    return res.status(500).json({ error: 'An unexpected server error occurred while processing the request.' });
  }
  res.status(500).send(
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Error - CRM</title><link rel="stylesheet" href="/static/css/style.css"></head><body><main style="min-height:100vh;display:grid;place-items:center;padding:24px;background:#f1f5f9;"><section class="card" style="width:min(100%,460px);"><div class="card-header"><div class="card-title">Something went wrong</div></div><div class="card-body"><div class="alert alert-danger">An unexpected error occurred while loading this page.</div><a class="btn btn-primary" href="/dashboard">Return to Dashboard</a></div></section></main></body></html>'
  );
});

// Start standalone HTTP server (skipped on Vercel serverless functions)
if (!process.env.VERCEL && !process.env.SERVERLESS) {
  app.listen(PORT, HOST, () => {
    console.log(`CRM Application listening on http://${HOST}:${PORT}`);
  });
}

export default app;
export { app };

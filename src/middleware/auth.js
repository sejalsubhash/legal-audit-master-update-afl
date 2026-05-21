// ─────────────────────────────────────────────────────────────
// Auth middleware
//
// Role source-of-truth:
//   ADMIN_EMAILS env var — a comma-separated list of admin email
//   addresses (e.g. "ajit.jadhav@acc.ltd, ceo@acc.ltd").
//
// Why an env var instead of a DB:
//   - No database in this stack (everything is S3 + Lambda/ECS).
//   - Admins change rarely; updating a Lambda/ECS env var (or the
//     Secrets Manager secret) is a one-click change with no redeploy
//     of the application code.
//   - Re-evaluated on every login and every protected request, so
//     removing someone from ADMIN_EMAILS takes effect immediately.
// ─────────────────────────────────────────────────────────────

function getAdminEmails() {
  const raw = process.env.ADMIN_EMAILS || '';
  return raw
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(email) {
  if (!email) return false;
  return getAdminEmails().includes(email.toLowerCase());
}

export function resolveRole(email) {
  return isAdmin(email) ? 'admin' : 'user';
}

// ─────────────────────────────────────────────────────────────
// authenticate — verifies the Bearer token and attaches req.user
// ─────────────────────────────────────────────────────────────
export function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());

    if (!decoded.exp || decoded.exp < Date.now()) {
      return res.status(401).json({ error: 'Token expired' });
    }

    req.user = {
      email: decoded.email,
      role: decoded.role
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─────────────────────────────────────────────────────────────
// requireAdmin — must run AFTER authenticate
//
// Re-checks the user's email against ADMIN_EMAILS on every call
// rather than trusting req.user.role blindly. This means removing
// someone from ADMIN_EMAILS revokes their admin access immediately,
// even if they still hold a valid token from before the change.
// ─────────────────────────────────────────────────────────────
export function requireAdmin(req, res, next) {
  if (!req.user?.email || !isAdmin(req.user.email)) {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
}

import express from 'express';
import { getJsonFromS3, putJsonToS3 } from '../services/s3Service.js';
import { resolveRole } from '../middleware/auth.js';

const router = express.Router();

// Mock Office 365 login
router.post('/login', async (req, res) => {
  try {
    const { email, name } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Load users from S3
    let userData;
    try {
      userData = await getJsonFromS3('users/users.json');
    } catch (err) {
      userData = { users: [] };
    }

    // Resolve role from ADMIN_EMAILS env var every time the user logs in.
    // This way, adding or removing someone from ADMIN_EMAILS takes effect
    // on their next login — no DB update or redeploy needed.
    const role = resolveRole(email);

    // Find or create user
    let user = userData.users.find(u => u.email.toLowerCase() === email.toLowerCase());
    
    if (!user) {
      user = {
        email: email.toLowerCase(),
        name: name || email.split('@')[0],
        role,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString()
      };
      userData.users.push(user);
      await putJsonToS3('users/users.json', userData);
    } else {
      // Keep the stored role in sync with the current ADMIN_EMAILS list
      user.role = role;
      user.lastLogin = new Date().toISOString();
      await putJsonToS3('users/users.json', userData);
    }

    // Return user data (in production, this would be a JWT token)
    res.json({
      success: true,
      user: {
        email: user.email,
        name: user.name,
        role: user.role
      },
      token: Buffer.from(JSON.stringify({ 
        email: user.email, 
        role: user.role,
        exp: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
      })).toString('base64')
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify token
router.get('/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString());

    if (decoded.exp < Date.now()) {
      return res.status(401).json({ error: 'Token expired' });
    }

    // Re-resolve the role against the current ADMIN_EMAILS list so a
    // user removed from the admin list loses admin privileges on the
    // next /verify call, without having to wait for token expiry.
    const role = resolveRole(decoded.email);

    res.json({
      valid: true,
      user: {
        email: decoded.email,
        role
      }
    });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Logout (client-side only for mock SSO)
router.post('/logout', (req, res) => {
  res.json({ success: true });
});

export default router;

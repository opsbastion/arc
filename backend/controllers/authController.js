const User = require('../models/User');
const { generateToken, generateRefreshToken } = require('../utils/jwt');
const { uploadAvatar } = require('../utils/cloudinary');

// Register new user
const register = async (req, res) => {
  try {
    const { username, email, password, userType, displayName, bio, location, website } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email or username already exists'
      });
    }

    // Handle avatar upload if provided
    let avatarData = {};
    if (req.file) {
      try {
        const uploadResult = await uploadAvatar(req.file);
        avatarData.avatar = uploadResult.url;
      } catch (uploadError) {
        return res.status(400).json({
          success: false,
          message: 'Failed to upload avatar',
          error: uploadError.message
        });
      }
    }

    // Create new user
    const userData = {
      username,
      email,
      password,
      userType,
      profile: {
        displayName,
        bio: bio || '',
        location: location || '',
        website: website || '',
        ...avatarData
      }
    };

    // Initialize type-specific fields
    if (userType === 'player') {
      userData.playerInfo = {
        games: [],
        achievements: [],
        lookingForTeam: false,
        preferredRoles: [],
        skillLevel: 'beginner'
      };
    } else if (userType === 'team') {
      userData.teamInfo = {
        teamSize: 0,
        recruitingFor: [],
        requirements: '',
        teamType: 'casual',
        members: []
      };
    }

    const user = await User.create(userData);

    // Generate tokens
    const token = generateToken({ id: user._id, userType: user.userType });
    const refreshToken = generateRefreshToken({ id: user._id });

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        user: userResponse,
        token,
        refreshToken
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: error.message
    });
  }
};

// Login user
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password'
      });
    }

    // Find user and include password for comparison
    const user = await User.findOne({ email }).select('+password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated. Please contact support.'
      });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update last seen
    user.lastSeen = new Date();
    await user.save();

    // Generate tokens
    const token = generateToken({ id: user._id, userType: user.userType });
    const refreshToken = generateRefreshToken({ id: user._id });

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: userResponse,
      refreshToken,
      data: {
        user: userResponse,
        token,
        refreshToken
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: error.message
    });
  }
};

// Get current user profile
const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('followers', 'username profile.displayName profile.avatar')
      .populate('following', 'username profile.displayName profile.avatar');

    res.status(200).json({
      success: true,
      data: {
        user
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get user profile',
      error: error.message
    });
  }
};

// Update user profile
const updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    const userId = req.user._id;

    // Handle avatar upload if provided
    if (req.file) {
      try {
        const uploadResult = await uploadAvatar(req.file);
        updates['profile.avatar'] = uploadResult.url;
      } catch (uploadError) {
        return res.status(400).json({
          success: false,
          message: 'Failed to upload avatar',
          error: uploadError.message
        });
      }
    }

    // Build update object for nested fields
    const updateObject = {};
    
    // Handle profile updates
    if (updates.displayName) updateObject['profile.displayName'] = updates.displayName;
    if (updates.bio !== undefined) updateObject['profile.bio'] = updates.bio;
    if (updates.location !== undefined) updateObject['profile.location'] = updates.location;
    if (updates.website !== undefined) updateObject['profile.website'] = updates.website;
    if (updates['profile.avatar']) updateObject['profile.avatar'] = updates['profile.avatar'];
    if (updates.gamingPreferences !== undefined) updateObject['profile.gamingPreferences'] = updates.gamingPreferences;
    if (updates.socialLinks !== undefined) updateObject['profile.socialLinks'] = updates.socialLinks;

    // Handle player-specific updates
    if (req.user.userType === 'player' && updates.playerInfo) {
      Object.keys(updates.playerInfo).forEach(key => {
        updateObject[`playerInfo.${key}`] = updates.playerInfo[key];
      });
    }

    // Handle team-specific updates
    if (req.user.userType === 'team' && updates.teamInfo) {
      Object.keys(updates.teamInfo).forEach(key => {
        updateObject[`teamInfo.${key}`] = updates.teamInfo[key];
      });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      updateObject,
      { new: true, runValidators: true }
    ).populate('followers', 'username profile.displayName profile.avatar')
     .populate('following', 'username profile.displayName profile.avatar');

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: error.message
    });
  }
};

// Change password
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide current password and new password'
      });
    }

    // Get user with password
    const user = await User.findById(req.user._id).select('+password');

    // Verify current password
    const isCurrentPasswordValid = await user.comparePassword(currentPassword);

    if (!isCurrentPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to change password',
      error: error.message
    });
  }
};

// Logout user (client-side token removal)
const logout = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Logout failed',
      error: error.message
    });
  }
};

module.exports = {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
  logout
};

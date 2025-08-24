const User = require('../models/User');
const Post = require('../models/Post');
const Notification = require('../models/Notification');
const RosterInvite = require('../models/RosterInvite');
const StaffInvite = require('../models/StaffInvite');
const { emitNotification, emitNotificationToMultiple } = require('../utils/notificationEmitter');

// Get all users (with search and filters)
const getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const { search, userType, skillLevel, lookingForTeam, recruiting } = req.query;

    // Build filter object
    const filter = { isActive: true };

    if (userType) filter.userType = userType;
    if (skillLevel) filter['playerInfo.skillLevel'] = skillLevel;
    if (lookingForTeam === 'true') filter['playerInfo.lookingForTeam'] = true;
    if (recruiting === 'true') filter['teamInfo.recruitingFor.0'] = { $exists: true };

    // Search functionality
    if (search) {
      filter.$or = [
        { username: { $regex: search, $options: 'i' } },
        { 'profile.displayName': { $regex: search, $options: 'i' } },
        { 'profile.bio': { $regex: search, $options: 'i' } },
        { 'playerInfo.games.name': { $regex: search, $options: 'i' } },
        { 'teamInfo.recruitingFor': { $regex: search, $options: 'i' } }
      ];
    }

    const users = await User.find(filter)
      .select('-password -email')
      .populate('followers', 'username profile.displayName profile.avatar')
      .populate('following', 'username profile.displayName profile.avatar')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await User.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: {
        users,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: users.length,
          totalUsers: total
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message
    });
  }
};

// Get user by ID or username
const getUser = async (req, res) => {
  try {
    const { identifier } = req.params;
    
    // Try to find by ID first, then by username
    let user;
    if (identifier.match(/^[0-9a-fA-F]{24}$/)) {
      // It's a valid ObjectId
      user = await User.findById(identifier);
    } else {
      // It's a username
      user = await User.findOne({ username: identifier });
    }

    if (!user || !user.isActive) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Populate team information if it's a team
    if (user.userType === 'team') {
      console.log('Populating team info for team:', user.username);
      await user.populateTeamInfo();
      console.log('Team staff after population:', user.teamInfo?.staff?.length || 0);
      console.log('Team staff data:', JSON.stringify(user.teamInfo?.staff, null, 2));
    }
    
    // Ensure playerInfo.joinedTeams exists for players
    if (user.userType === 'player') {
      if (!user.playerInfo) {
        user.playerInfo = {};
      }
      if (!user.playerInfo.joinedTeams) {
        user.playerInfo.joinedTeams = [];
      }
      
      console.log('Player found, joinedTeams before population:', user.playerInfo.joinedTeams.length);
      console.log('JoinedTeams data:', JSON.stringify(user.playerInfo.joinedTeams, null, 2));
      
      await user.populate('playerInfo.joinedTeams.team', 'username profile.displayName profile.avatar');
      
      console.log('JoinedTeams after population:', user.playerInfo.joinedTeams.length);
      console.log('JoinedTeams populated data:', JSON.stringify(user.playerInfo.joinedTeams, null, 2));
    } else {
      console.log('User type:', user.userType);
      console.log('PlayerInfo exists:', !!user.playerInfo);
      console.log('JoinedTeams exists:', !!user.playerInfo?.joinedTeams);
      if (user.playerInfo?.joinedTeams) {
        console.log('JoinedTeams length:', user.playerInfo.joinedTeams.length);
      }
    }
    
    // Get user's public profile
    const publicProfile = user.getPublicProfile();
    
    // Ensure joinedTeams data is properly included for players
    if (user.userType === 'player' && user.playerInfo?.joinedTeams) {
      publicProfile.playerInfo = publicProfile.playerInfo || {};
      publicProfile.playerInfo.joinedTeams = user.playerInfo.joinedTeams;
    }
    
    // Get user's recent posts
    const recentPosts = await Post.find({ 
      author: user._id, 
      isActive: true,
      visibility: { $in: ['public', 'followers'] }
    })
    .populate('author', 'username profile.displayName profile.avatar userType')
    .sort({ createdAt: -1 })
    .limit(5);

    res.status(200).json({
      success: true,
      data: {
        user: publicProfile,
        recentPosts,
        stats: {
          followersCount: user.followers.length,
          followingCount: user.following.length,
          postsCount: user.posts.length
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: error.message
    });
  }
};

// Follow/Unfollow user
const toggleFollow = async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const currentUserId = req.user._id;
    console.log('Toggle follow - Target user:', targetUserId, 'Current user:', currentUserId);
    console.log('Request method:', req.method);

    if (targetUserId === currentUserId.toString()) {
      return res.status(400).json({
        success: false,
        message: 'You cannot follow yourself'
      });
    }

    const targetUser = await User.findById(targetUserId);
    const currentUser = await User.findById(currentUserId);

    if (!targetUser || !targetUser.isActive) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const isFollowing = currentUser.following.includes(targetUserId);
    console.log('Is following:', isFollowing);

    if (isFollowing) {
      // Unfollow
      console.log('Unfollowing user');
      currentUser.following.pull(targetUserId);
      targetUser.followers.pull(currentUserId);
    } else {
      // Follow
      console.log('Following user');
      currentUser.following.push(targetUserId);
      targetUser.followers.push(currentUserId);

      // Create notification
      try {
        await Notification.createNotification({
          recipient: targetUserId,
          sender: currentUserId,
          type: 'follow',
          title: 'New Follower',
          message: `${currentUser.profile.displayName || currentUser.username} started following you`
        });
      } catch (notificationError) {
        console.error('Error creating notification:', notificationError);
      }
    }

    await Promise.all([currentUser.save(), targetUser.save()]);

    res.status(200).json({
      success: true,
      message: isFollowing ? 'User unfollowed' : 'User followed',
      data: {
        isFollowing: !isFollowing,
        followersCount: targetUser.followers.length
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to toggle follow',
      error: error.message
    });
  }
};

// Get user's followers
const getFollowers = async (req, res) => {
  try {
    const userId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const user = await User.findById(userId)
      .populate({
        path: 'followers',
        select: 'username profile.displayName profile.avatar userType',
        options: {
          skip: skip,
          limit: limit
        }
      });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const totalFollowers = await User.findById(userId).select('followers');

    res.status(200).json({
      success: true,
      data: {
        followers: user.followers,
        pagination: {
          current: page,
          total: Math.ceil(totalFollowers.followers.length / limit),
          count: user.followers.length,
          totalFollowers: totalFollowers.followers.length
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch followers',
      error: error.message
    });
  }
};

// Get user's following
const getFollowing = async (req, res) => {
  try {
    const userId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const user = await User.findById(userId)
      .populate({
        path: 'following',
        select: 'username profile.displayName profile.avatar userType',
        options: {
          skip: skip,
          limit: limit
        }
      });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const totalFollowing = await User.findById(userId).select('following');

    res.status(200).json({
      success: true,
      data: {
        following: user.following,
        pagination: {
          current: page,
          total: Math.ceil(totalFollowing.following.length / limit),
          count: user.following.length,
          totalFollowing: totalFollowing.following.length
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch following',
      error: error.message
    });
  }
};

// Get user's posts
const getUserPosts = async (req, res) => {
  try {
    const userId = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    console.log('Getting posts for user:', userId);
    console.log('Current user:', req.user?._id);

    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Build visibility filter
    let visibilityFilter = ['public'];
    
    // If viewing own posts, include all visibility levels
    if (req.user && req.user._id.toString() === userId) {
      visibilityFilter = ['public', 'followers', 'private'];
    } 
    // If following the user, include followers posts
    else if (req.user && req.user.following.includes(userId)) {
      visibilityFilter = ['public', 'followers'];
    }

    console.log('Visibility filter:', visibilityFilter);
    const posts = await Post.find({
      author: userId,
      isActive: true,
      visibility: { $in: visibilityFilter }
    })
    .populate('author', 'username profile.displayName profile.avatar userType')
    .populate('likes.user', 'username profile.displayName profile.avatar')
    .populate('comments.user', 'username profile.displayName profile.avatar')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
    console.log('Found posts:', posts.length);

    const total = await Post.countDocuments({
      author: userId,
      isActive: true,
      visibility: { $in: visibilityFilter }
    });

    res.status(200).json({
      success: true,
      data: {
        posts,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: posts.length,
          totalPosts: total
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user posts',
      error: error.message
    });
  }
};

// Add player to roster (creates invite)
const addPlayerToRoster = async (req, res) => {
  try {
    const { teamId, game } = req.params;
    const { playerId, role, inGameName, message } = req.body;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can add players to rosters'
      });
    }

    // Verify the player exists and is a player
    const player = await User.findById(playerId);
    if (!player || player.userType !== 'player') {
      return res.status(404).json({
        success: false,
        message: 'Player not found'
      });
    }

    // Check if player is already in this roster (active only)
    const existingRoster = team.teamInfo.rosters.find(r => r.game === game);
    if (existingRoster) {
      const existingPlayer = existingRoster.players.find(p => p.user.toString() === playerId && p.isActive);
      if (existingPlayer) {
        return res.status(400).json({
          success: false,
          message: 'Player is already in this roster'
        });
      }
    }

    // Check if there's already a pending invite
    const existingInvite = await RosterInvite.findOne({
      team: teamId,
      player: playerId,
      game,
      status: 'pending'
    });

    if (existingInvite) {
      return res.status(400).json({
        success: false,
        message: 'Player already has a pending invite for this roster'
      });
    }

    // Create roster invite
    const invite = new RosterInvite({
      team: teamId,
      player: playerId,
      game,
      role: role || 'Player',
      inGameName,
      message
    });

    await invite.save();

    // Send invite as direct message instead of notification
    console.log('Sending roster invite message to player:', playerId);
    console.log('Team info:', team.profile?.displayName || team.username);
    
    try {
      await sendInviteMessage(teamId, playerId, 'roster', {
        inviteId: invite._id,
        game,
        role: role || 'Player',
        inGameName,
        message
      });
      console.log('Roster invite message sent successfully');
      
    } catch (messageError) {
      console.error('Error sending roster invite message:', messageError);
    }

    res.status(201).json({
      success: true,
      message: 'Roster invite sent successfully',
      data: { invite }
    });

  } catch (error) {
    console.error('Error adding player to roster:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add player to roster',
      error: error.message
    });
  }
};

// Add staff member (invite-based)
const addStaffMember = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { memberId, role, message } = req.body;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can invite staff members'
      });
    }

    // Verify the member exists
    const member = await User.findById(memberId);
    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    // Check if there's already a pending invite
    const existingInvite = await StaffInvite.findOne({
      team: teamId,
      player: memberId,
      status: 'pending'
    });

    if (existingInvite) {
      return res.status(400).json({
        success: false,
        message: 'An invite is already pending for this member'
      });
    }

    // Check if member is already in staff (active only)
    const existingStaff = team.teamInfo.staff.find(s => s.user.toString() === memberId && s.isActive);
    if (existingStaff) {
      return res.status(400).json({
        success: false,
        message: 'Member is already in the staff'
      });
    }

    // Create staff invite
    const staffInvite = new StaffInvite({
      team: teamId,
      player: memberId,
      role,
      message: message || `You've been invited to join ${team.profile?.displayName || team.username} as ${role}`
    });

    await staffInvite.save();

    // Send invite as direct message instead of notification
    console.log('Sending staff invite message to member:', memberId);
    console.log('Team info:', team.profile?.displayName || team.username);
    console.log('Staff invite ID:', staffInvite._id);
    console.log('Team ID:', teamId);
    console.log('Role:', role);
    
    try {
      await sendInviteMessage(teamId, memberId, 'staff', {
        inviteId: staffInvite._id,
        role,
        message: staffInvite.message
      });
      console.log('Staff invite message sent successfully');
      
    } catch (messageError) {
      console.error('Error sending staff invite message:', messageError);
      console.error('Error details:', {
        message: messageError.message,
        stack: messageError.stack
      });
    }

    res.status(200).json({
      success: true,
      message: 'Staff invitation sent successfully'
    });

  } catch (error) {
    console.error('Error sending staff invitation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send staff invitation',
      error: error.message
    });
  }
};

// Add staff member by username (invite-based)
const addStaffMemberByUsername = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { username, role, message } = req.body;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can invite staff members'
      });
    }

    // Find member by username
    const member = await User.findOne({ username: username });
    if (!member) {
      return res.status(404).json({
        success: false,
        message: `User with username '${username}' not found`
      });
    }

    const memberId = member._id;

    // Check if there's already a pending invite
    const existingInvite = await StaffInvite.findOne({
      team: teamId,
      player: memberId,
      status: 'pending'
    });

    if (existingInvite) {
      return res.status(400).json({
        success: false,
        message: 'An invite is already pending for this member'
      });
    }

    // Check if member is already in staff (active only)
    const existingStaff = team.teamInfo.staff.find(s => s.user.toString() === memberId && s.isActive);
    if (existingStaff) {
      return res.status(400).json({
        success: false,
        message: 'Member is already in the staff'
      });
    }

    // Create staff invite
    const staffInvite = new StaffInvite({
      team: teamId,
      player: memberId,
      role,
      message: message || `You've been invited to join ${team.profile?.displayName || team.username} as ${role}`
    });

    await staffInvite.save();

    // Send invite as direct message instead of notification
    console.log('Sending staff invite message to member:', memberId);
    console.log('Member username:', member.username);
    console.log('Team info:', team.profile?.displayName || team.username);
    console.log('Staff invite ID:', staffInvite._id);
    console.log('Team ID:', teamId);
    console.log('Role:', role);
    
    try {
      await sendInviteMessage(teamId, memberId, 'staff', {
        inviteId: staffInvite._id,
        role,
        message: staffInvite.message
      });
      console.log('Staff invite message sent successfully');
      
    } catch (messageError) {
      console.error('Error sending staff invite message:', messageError);
      console.error('Error details:', {
        message: messageError.message,
        stack: messageError.stack
      });
    }

    res.status(200).json({
      success: true,
      message: `Staff invitation sent successfully to ${member.username}`,
      data: {
        invitedUser: {
          id: member._id,
          username: member.username,
          displayName: member.profile?.displayName
        },
        role: role,
        inviteId: staffInvite._id
      }
    });

  } catch (error) {
    console.error('Error sending staff invitation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send staff invitation',
      error: error.message
    });
  }
};

// Remove player from roster
const removePlayerFromRoster = async (req, res) => {
  try {
    const { teamId, game, playerId } = req.params;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can remove players from rosters'
      });
    }

    // Find and completely remove player from roster
    const roster = team.teamInfo.rosters.find(r => r.game === game);
    if (!roster) {
      return res.status(404).json({
        success: false,
        message: 'Roster not found'
      });
    }

    const playerIndex = roster.players.findIndex(p => p.user.toString() === playerId && p.isActive);
    if (playerIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Player not found in roster'
      });
    }

    // Mark player as inactive
    roster.players[playerIndex].isActive = false;
    roster.players[playerIndex].leftAt = new Date();
    await team.save();

    // Mark as inactive in player's joinedTeams
    const playerUser = await User.findById(playerId);
    if (playerUser && playerUser.userType === 'player') {
      const teamMembership = playerUser.playerInfo.joinedTeams.find(
        teamRef => teamRef.team.toString() === teamId && teamRef.game === game
      );
      if (teamMembership) {
        teamMembership.isActive = false;
        teamMembership.leftAt = new Date();
        await playerUser.save();
      }
    }

    res.status(200).json({
      success: true,
      message: 'Player removed from roster successfully'
    });

  } catch (error) {
    console.error('Error removing player from roster:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove player from roster',
      error: error.message
    });
  }
};

// Remove staff member
const removeStaffMember = async (req, res) => {
  try {
    const { teamId, playerId } = req.params;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can remove staff members'
      });
    }

    // Find and completely remove staff member from team
    console.log('Looking for staff member with ID:', playerId);
    console.log('Current staff members:', team.teamInfo.staff);
    
    const staffIndex = team.teamInfo.staff.findIndex(s => s.user.toString() === playerId);
    console.log('Staff index found:', staffIndex);
    
    if (staffIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Staff member not found'
      });
    }

    // Mark staff member as inactive
    team.teamInfo.staff[staffIndex].isActive = false;
    team.teamInfo.staff[staffIndex].leftAt = new Date();
    await team.save();

    // Update player's joinedTeams to mark as inactive
    const player = await User.findById(playerId);
    if (player && player.userType === 'player') {
      const teamMembership = player.playerInfo.joinedTeams.find(
        teamRef => teamRef.team.toString() === teamId && teamRef.game === 'Staff'
      );
      if (teamMembership) {
        teamMembership.isActive = false;
        teamMembership.leftAt = new Date();
        await player.save();
      }
    }

    res.status(200).json({
      success: true,
      message: 'Staff member removed successfully'
    });

  } catch (error) {
    console.error('Error removing staff member:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove staff member',
      error: error.message
    });
  }
};

// Temporary function to manually add team to player's joined teams (for testing)
const addTeamToPlayer = async (req, res) => {
  try {
    const { playerId, teamId } = req.params;
    const { role, game } = req.body;

    // Find the player
    const player = await User.findById(playerId);
    if (!player || player.userType !== 'player') {
      return res.status(404).json({
        success: false,
        message: 'Player not found'
      });
    }

    // Find the team
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Ensure playerInfo and joinedTeams exist
    if (!player.playerInfo) {
      player.playerInfo = {};
    }
    if (!player.playerInfo.joinedTeams) {
      player.playerInfo.joinedTeams = [];
    }

    // Check if player is already in this team
    const existingMembership = player.playerInfo.joinedTeams.find(
      membership => membership.team.toString() === teamId
    );

    if (!existingMembership) {
      // Add new team membership
      player.playerInfo.joinedTeams.push({
        team: teamId,
        game: game || 'Staff',
        role: role || 'Staff Member',
        inGameName: null,
        joinedAt: new Date(),
        leftAt: null,
        isActive: true
      });

      await player.save();
      console.log('Team added to player successfully');
    } else {
      console.log('Player already has membership in this team');
    }

    res.status(200).json({
      success: true,
      message: 'Team added to player successfully',
      data: {
        playerId,
        teamId,
        joinedTeams: player.playerInfo.joinedTeams
      }
    });

  } catch (error) {
    console.error('Error adding team to player:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add team to player',
      error: error.message
    });
  }
};

// Get pending invites for a team
const getTeamPendingInvites = async (req, res) => {
  try {
    const { teamId } = req.params;
    const currentUserId = req.user._id;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== currentUserId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can view pending invites'
      });
    }

    // Get pending roster invites
    const pendingRosterInvites = await RosterInvite.find({
      team: teamId,
      status: 'pending'
    }).populate('player', 'username profile.displayName profile.avatar');

    // Get pending staff invites
    const pendingStaffInvites = await StaffInvite.find({
      team: teamId,
      status: 'pending'
    }).populate('player', 'username profile.displayName profile.avatar');

    res.status(200).json({
      success: true,
      data: {
        rosterInvites: pendingRosterInvites,
        staffInvites: pendingStaffInvites
      }
    });

  } catch (error) {
    console.error('Error fetching pending invites:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending invites',
      error: error.message
    });
  }
};

// Cancel roster invite
const cancelRosterInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;
    const currentUserId = req.user._id;

    console.log('Cancelling roster invite:', { inviteId, currentUserId });

    const invite = await RosterInvite.findById(inviteId);
    if (!invite) {
      console.log('Roster invite not found:', inviteId);
      return res.status(404).json({
        success: false,
        message: 'Invite not found'
      });
    }

    console.log('Found roster invite:', { 
      inviteId: invite._id, 
      team: invite.team, 
      currentUserId,
      status: invite.status 
    });

    // Verify the current user is the team owner
    if (invite.team.toString() !== currentUserId.toString()) {
      console.log('Permission denied: user is not team owner');
      return res.status(403).json({
        success: false,
        message: 'Only team owners can cancel invites'
      });
    }

    invite.status = 'cancelled';
    await invite.save();

    console.log('Roster invite cancelled successfully');

    res.status(200).json({
      success: true,
      message: 'Roster invite cancelled successfully'
    });

  } catch (error) {
    console.error('Error cancelling roster invite:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel roster invite',
      error: error.message
    });
  }
};

// Cancel staff invite
const cancelStaffInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;
    const currentUserId = req.user._id;

    console.log('Cancelling staff invite:', { inviteId, currentUserId });

    const invite = await StaffInvite.findById(inviteId);
    if (!invite) {
      console.log('Staff invite not found:', inviteId);
      return res.status(404).json({
        success: false,
        message: 'Invite not found'
      });
    }

    console.log('Found staff invite:', { 
      inviteId: invite._id, 
      team: invite.team, 
      currentUserId,
      status: invite.status 
    });

    // Verify the current user is the team owner
    if (invite.team.toString() !== currentUserId.toString()) {
      console.log('Permission denied: user is not team owner');
      return res.status(403).json({
        success: false,
        message: 'Only team owners can cancel invites'
      });
    }

    invite.status = 'cancelled';
    await invite.save();

    console.log('Staff invite cancelled successfully');

    res.status(200).json({
      success: true,
      message: 'Staff invite cancelled successfully'
    });

  } catch (error) {
    console.error('Error cancelling staff invite:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel staff invite',
      error: error.message
    });
  }
};

// Cancel staff invite by username
const cancelStaffInviteByUsername = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { username } = req.body;
    const currentUserId = req.user._id;

    console.log('Cancelling staff invite by username:', { teamId, username, currentUserId });

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== currentUserId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can cancel invites'
      });
    }

    // Find the user by username
    const user = await User.findOne({ username: username });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: `User with username '${username}' not found`
      });
    }

    // Find the pending invite for this user
    const invite = await StaffInvite.findOne({
      team: teamId,
      player: user._id,
      status: 'pending'
    });

    if (!invite) {
      return res.status(404).json({
        success: false,
        message: `No pending invite found for user '${username}'`
      });
    }

    console.log('Found staff invite to cancel:', { 
      inviteId: invite._id, 
      team: invite.team, 
      player: invite.player,
      username: username,
      status: invite.status 
    });

    // Cancel the invite
    invite.status = 'cancelled';
    await invite.save();

    console.log('Staff invite cancelled successfully for username:', username);

    res.status(200).json({
      success: true,
      message: `Staff invite cancelled successfully for ${username}`,
      data: {
        cancelledUser: {
          id: user._id,
          username: user.username,
          displayName: user.profile?.displayName
        },
        inviteId: invite._id
      }
    });

  } catch (error) {
    console.error('Error cancelling staff invite by username:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel staff invite',
      error: error.message
    });
  }
};

// Player leaves team
const leaveTeam = async (req, res) => {
  try {
    const { teamId, game } = req.params;
    const playerId = req.user._id;

    console.log('Player leaving team:', { teamId, game, playerId });

    // Verify the player exists
    const player = await User.findById(playerId);
    if (!player || player.userType !== 'player') {
      return res.status(404).json({
        success: false,
        message: 'Player not found'
      });
    }

    // Verify the team exists
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Find the team membership in player's joinedTeams
    const teamMembership = player.playerInfo.joinedTeams.find(
      membership => membership.team.toString() === teamId && 
                   (membership.game === game || (game === 'Staff' && membership.game === 'Staff')) && 
                   membership.isActive
    );

    if (!teamMembership) {
      return res.status(404).json({
        success: false,
        message: 'You are not a member of this team'
      });
    }

    // Mark the membership as inactive and set leftAt date
    teamMembership.isActive = false;
    teamMembership.leftAt = new Date();
    
    // Save the player changes
    await player.save();
    console.log('Player saved successfully, updated membership:', teamMembership);

    // For staff members, check if they have a pending leave request
    if (game === 'Staff') {
      const staffMember = team.teamInfo.staff.find(s => s.user.toString() === playerId && s.isActive);
      if (staffMember) {
        // Check if they have a pending leave request
        const LeaveRequest = require('../models/LeaveRequest');
        const pendingRequest = await LeaveRequest.findOne({
          team: teamId,
          staffMember: playerId,
          status: 'pending'
        });

        if (pendingRequest) {
          return res.status(400).json({
            success: false,
            message: 'You have a pending leave request. Please wait for admin approval or cancel the request first.'
          });
        }

        // If no pending request, create one
        const leaveRequest = new LeaveRequest({
          team: teamId,
          staffMember: playerId,
          reason: 'Direct leave request'
        });

        await leaveRequest.save();

        // Update staff member status
        staffMember.leaveRequestStatus = 'pending';
        await team.save();

        return res.status(200).json({
          success: true,
          message: 'Leave request created successfully. Please wait for admin approval.',
          data: {
            leaveRequestId: leaveRequest._id
          }
        });
      } else {
        console.log('Staff member not found or not active');
        return res.status(404).json({
          success: false,
          message: 'You are not an active staff member of this team'
        });
      }
    } else {
      // For roster players, completely remove from roster array
      const roster = team.teamInfo.rosters.find(r => r.game === game);
      if (roster) {
        const playerIndex = roster.players.findIndex(p => p.user.toString() === playerId && p.isActive);
        if (playerIndex !== -1) {
          console.log('Found player in roster at index:', playerIndex);
          // Mark player as inactive
          roster.players[playerIndex].isActive = false;
          roster.players[playerIndex].leftAt = new Date();
          console.log('Player marked as inactive in roster');
          await team.save();
          console.log('Team saved successfully for roster removal');
        } else {
          console.log('Player not found in roster');
          return res.status(404).json({
            success: false,
            message: 'Player not found in roster'
          });
        }
      } else {
        console.log('Roster not found for game:', game);
        return res.status(404).json({
          success: false,
          message: 'Roster not found for this game'
        });
      }
    }

    console.log('Player successfully left team');

    // Send notification to team about player leaving
    try {
      const notification = {
        type: 'player_left_team',
        title: 'Player Left Team',
        message: `${player.profile.displayName} has left your team`,
        data: {
          playerId: player._id,
          playerName: player.profile.displayName,
          game: game,
          teamId: team._id,
          teamName: team.profile.displayName
        }
      };
      
      // Notify team owner and active staff members
      const teamOwnerId = team._id;
      const staffIds = team.teamInfo.staff
        .filter(staff => staff.isActive && staff.user.toString() !== playerId.toString())
        .map(staff => staff.user);
      
      const recipients = [teamOwnerId, ...staffIds];
      emitNotificationToMultiple(recipients, notification);
      
      console.log('Notification sent to team members about player leaving');
    } catch (notificationError) {
      console.error('Error sending notification:', notificationError);
    }

    res.status(200).json({
      success: true,
      message: 'Successfully left the team'
    });

  } catch (error) {
    console.error('Error leaving team:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to leave team',
      error: error.message
    });
  }
};

// Send invite message directly to player's DM
const sendInviteMessage = async (teamId, playerId, inviteType, inviteData) => {
  try {
    const { Message } = require('../models/Message');
    const team = await User.findById(teamId);
    const player = await User.findById(playerId);
    
    if (!team || !player) {
      throw new Error('Team or player not found');
    }

    let messageText = '';
    let inviteId = '';

    if (inviteType === 'roster') {
      const { game, role, inGameName, message } = inviteData;
      messageText = `🎮 **Team Invitation - ${game} Roster**\n\n` +
        `**Team:** ${team.profile?.displayName || team.username}\n` +
        `**Position:** ${role || 'Player'}\n` +
        `**Game:** ${game}\n` +
        (inGameName ? `**In-Game Name:** ${inGameName}\n` : '') +
        (message ? `**Message:** ${message}\n\n` : '\n') +
        `You've been invited to join our ${game} roster! Please respond to this message with:\n` +
        `• "Accept" - to join the team\n` +
        `• "Decline" - to decline the invitation\n\n` +
        `This invitation will expire in 7 days.`;
      
      inviteId = inviteData.inviteId;
    } else if (inviteType === 'staff') {
      const { role, message } = inviteData;
      messageText = `👥 **Staff Invitation**\n\n` +
        `**Team:** ${team.profile?.displayName || team.username}\n` +
        `**Role:** ${role}\n` +
        (message ? `**Message:** ${message}\n\n` : '\n') +
        `You've been invited to join our team as ${role}! Please respond to this message with:\n` +
        `• "Accept" - to join the team\n` +
        `• "Decline" - to decline the invitation\n\n` +
        `This invitation will expire in 7 days.`;
      
      inviteId = inviteData.inviteId;
    }

    // Create the message
    const messageData = {
      sender: teamId,
      recipient: playerId,
      messageType: 'direct',
      content: {
        text: messageText,
        media: []
      },
      inviteData: {
        type: inviteType,
        inviteId: inviteId,
        teamId: teamId,
        ...inviteData
      }
    };

    const message = await Message.create(messageData);
    
    // Populate sender and recipient info
    await message.populate([
      { path: 'sender', select: 'username profile.displayName profile.avatar' },
      { path: 'recipient', select: 'username profile.displayName profile.avatar' }
    ]);

    // Create a simple notification for the message (not the invite)
    await Notification.createNotification({
      recipient: playerId,
      sender: teamId,
      type: 'message',
      title: 'New Message',
      message: `${team.profile?.displayName || team.username} sent you a message`,
      data: {
        messageId: message._id
      }
    });

    return message;
  } catch (error) {
    console.error('Error sending invite message:', error);
    throw error;
  }
};

// Get current user's profile with team ownership/staff info for compatibility
const getCurrentUserProfile = async (req, res) => {
	try {
		const currentUser = await User.findById(req.user._id);
		if (!currentUser || !currentUser.isActive) {
			return res.status(404).json({ success: false, message: 'User not found' });
		}

		const profileResponse = { userId: currentUser._id };

		// For team users: treat the current user as the owned team
		if (currentUser.userType === 'team') {
			await currentUser.populateTeamInfo();
			const teamSummary = {
				_id: currentUser._id,
				teamName: currentUser.profile?.displayName || currentUser.username,
				staff: (currentUser.teamInfo?.staff || []).map((s) => ({
					user: s.user,
					role: s.role,
					joinedAt: s.joinedAt,
					leftAt: s.leftAt,
					isActive: s.isActive
				}))
			};
			profileResponse.teamInfo = { ownedTeams: [teamSummary] };
		} else {
			// For player users: find teams where user is active staff
			const teams = await User.find({
				userType: 'team',
				'teamInfo.staff': { $elemMatch: { user: currentUser._id, isActive: true } }
			});
			const staffMemberships = teams.map((team) => {
				const staffEntry = team.teamInfo.staff.find((s) => s.user.toString() === currentUser._id.toString() && s.isActive);
				return {
					team: {
						_id: team._id,
						teamName: team.profile?.displayName || team.username
					},
					role: staffEntry?.role || 'Member',
					isActive: true
				};
			});
			profileResponse.teamInfo = { staff: staffMemberships };
		}

		return res.status(200).json(profileResponse);
	} catch (error) {
		return res.status(500).json({ success: false, message: 'Failed to fetch profile', error: error.message });
	}
};

// Directly add a staff member to a team by username (compatibility for tests)
const addStaffDirect = async (req, res) => {
	try {
		const teamId = req.params.id;
		const { username } = req.body;
		let { role } = req.body;
		if (!role) role = 'Manager';

		const team = await User.findById(teamId);
		if (!team || team.userType !== 'team') {
			return res.status(404).json({ success: false, message: 'Team not found' });
		}

		// Only team owner can add staff directly
		if (team._id.toString() !== req.user._id.toString()) {
			return res.status(403).json({ success: false, message: 'Only team owners can add staff' });
		}

		const member = await User.findOne({ username });
		if (!member) {
			return res.status(404).json({ success: false, message: `User with username '${username}' not found` });
		}

		// Already a staff member?
		const existingStaff = (team.teamInfo?.staff || []).find((s) => s.user.toString() === member._id.toString() && s.isActive);
		if (existingStaff) {
			return res.status(400).json({ success: false, message: 'already a staff member' });
		}

		// Add to team staff
		team.teamInfo = team.teamInfo || {};
		team.teamInfo.staff = team.teamInfo.staff || [];
		team.teamInfo.staff.push({ user: member._id, role, isActive: true, joinedAt: new Date() });
		await team.save();

		// Track membership on player side for consistency (as a special 'Staff' entry)
		if (member.userType === 'player') {
			member.playerInfo = member.playerInfo || {};
			member.playerInfo.joinedTeams = member.playerInfo.joinedTeams || [];
			const alreadyJoined = member.playerInfo.joinedTeams.find((jt) => jt.team?.toString() === team._id.toString() && jt.game === 'Staff' && jt.isActive);
			if (!alreadyJoined) {
				member.playerInfo.joinedTeams.push({ team: team._id, game: 'Staff', role: role, joinedAt: new Date(), isActive: true });
				await member.save();
			}
		}

		return res.status(200).json({ success: true, message: 'Staff user added to team' });
	} catch (error) {
		console.error('Error in addStaffDirect:', error);
		return res.status(500).json({ success: false, message: 'Failed to add staff', error: error.message });
	}
};


module.exports = {
  getUsers,
  getUser,
  toggleFollow,
  getFollowers,
  getFollowing,
  getUserPosts,
  addPlayerToRoster,
  addStaffMember,
  addStaffMemberByUsername,
  removePlayerFromRoster,
  removeStaffMember,
  addTeamToPlayer,
  getTeamPendingInvites,
  cancelRosterInvite,
  cancelStaffInvite,
  cancelStaffInviteByUsername,
  leaveTeam,
  getCurrentUserProfile,
  addStaffDirect
};

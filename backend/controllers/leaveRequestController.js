const User = require('../models/User');
const LeaveRequest = require('../models/LeaveRequest');
const Notification = require('../models/Notification');
const { emitNotification, emitNotificationToMultiple } = require('../utils/notificationEmitter');

// Create leave request
const createLeaveRequest = async (req, res) => {
	try {
		const { teamId } = req.params;
		const { reason } = req.body;
		const staffMemberId = req.user._id;

		console.log('Creating leave request:', { teamId, staffMemberId, reason });

		// Verify the team exists
		const team = await User.findById(teamId);
		if (!team || team.userType !== 'team') {
			return res.status(404).json({ success: false, message: 'Team not found' });
		}

		// Check if user is actually a staff member of this team
		const staffMember = team.teamInfo.staff.find(s => 
			s.user.toString() === staffMemberId.toString() && s.isActive
		);

		if (!staffMember) {
			return res.status(404).json({ success: false, message: 'You are not a staff member of this team' });
		}

		// Check if there's already a pending leave request
		const existingRequest = await LeaveRequest.findOne({
			team: teamId,
			staffMember: staffMemberId,
			status: 'pending'
		});

		if (existingRequest) {
			return res.status(400).json({ success: false, message: 'You already have a pending leave request for this team' });
		}

		// Create the leave request
		const leaveRequest = new LeaveRequest({ team: teamId, staffMember: staffMemberId, reason: reason || '' });
		await leaveRequest.save();

		// Update staff member's leave request status
		staffMember.leaveRequestStatus = 'pending';
		await team.save();

		// Send notification to team owner and other admins
		const notification = {
			type: 'leave_request',
			title: 'Staff Leave Request',
			message: `${req.user.profile.displayName} has requested to leave the team`,
			data: { leaveRequestId: leaveRequest._id, staffMemberId: staffMemberId, staffMemberName: req.user.profile.displayName, teamId: teamId, teamName: team.profile.displayName, reason: reason }
		};

		const teamOwnerId = team._id;
		const otherStaffIds = team.teamInfo.staff
			.filter(staff => staff.isActive && staff.user.toString() !== staffMemberId.toString())
			.map(staff => staff.user);

		const recipients = [teamOwnerId, ...otherStaffIds];
		emitNotificationToMultiple(recipients, notification);

		// Return the leave request object directly for compatibility
		return res.status(201).json(leaveRequest);
	} catch (error) {
		console.error('Error creating leave request:', error);
		return res.status(500).json({ success: false, message: 'Failed to create leave request', error: error.message });
	}
};

// Get leave requests for a team (admin only)
const getTeamLeaveRequests = async (req, res) => {
	try {
		const { teamId } = req.params;
		const adminId = req.user._id;

		// Verify the team exists and user is admin
		const team = await User.findById(teamId);
		if (!team || team.userType !== 'team') {
			return res.status(404).json({ success: false, message: 'Team not found' });
		}

		// Check if user is team owner or active staff member
		const isOwner = team._id.toString() === adminId.toString();
		const isStaff = team.teamInfo.staff.find(s => s.user.toString() === adminId.toString() && s.isActive);

		if (!isOwner && !isStaff) {
			return res.status(403).json({ success: false, message: 'You are not authorized to view leave requests for this team' });
		}

		// Get all leave requests for this team
		const leaveRequests = await LeaveRequest.find({ team: teamId })
			.populate('staffMember', 'username profile.displayName profile.avatar')
			.populate('respondedBy', 'username profile.displayName')
			.sort({ createdAt: -1 });

		// Return array directly for compatibility
		return res.status(200).json(leaveRequests);
	} catch (error) {
		console.error('Error fetching leave requests:', error);
		return res.status(500).json({ success: false, message: 'Failed to fetch leave requests', error: error.message });
	}
};

// Get user's own leave requests
const getUserLeaveRequests = async (req, res) => {
	try {
		const userId = req.user._id;

		const leaveRequests = await LeaveRequest.find({ staffMember: userId })
			.populate('team', 'username profile.displayName profile.avatar')
			.populate('respondedBy', 'username profile.displayName')
			.sort({ createdAt: -1 });

		// Return array directly for compatibility
		return res.status(200).json(leaveRequests);
	} catch (error) {
		console.error('Error fetching user leave requests:', error);
		return res.status(500).json({ success: false, message: 'Failed to fetch leave requests', error: error.message });
	}
};

// Approve or reject leave request (admin only)
const respondToLeaveRequest = async (req, res) => {
	try {
		const { teamId, requestId } = req.params;
		const { action, adminResponse } = req.body; // action: 'approve' or 'reject'
		const adminId = req.user._id;

		console.log('Responding to leave request:', { teamId, requestId, action, adminResponse });

		// Verify the team exists and user is admin
		const team = await User.findById(teamId);
		if (!team || team.userType !== 'team') {
			return res.status(404).json({ success: false, message: 'Team not found' });
		}

		// Check if user is team owner or active staff member
		const isOwner = team._id.toString() === adminId.toString();
		const isStaff = team.teamInfo.staff.find(s => 
			s.user.toString() === adminId.toString() && s.isActive
		);

		if (!isOwner && !isStaff) {
			return res.status(403).json({ success: false, message: 'You are not authorized to respond to leave requests for this team' });
		}

		// Find the leave request
		const leaveRequest = await LeaveRequest.findById(requestId)
			.populate('staffMember', 'username profile.displayName');

		if (!leaveRequest || leaveRequest.team.toString() !== teamId) {
			return res.status(404).json({ success: false, message: 'Leave request not found' });
		}

		if (leaveRequest.status !== 'pending') {
			return res.status(400).json({ success: false, message: 'Leave request has already been processed' });
		}

		// Update leave request status
		leaveRequest.status = action === 'approve' ? 'approved' : 'rejected';
		leaveRequest.adminResponse = adminResponse || '';
		leaveRequest.respondedAt = new Date();
		leaveRequest.respondedBy = adminId;

		if (action === 'approve') {
			leaveRequest.leftDate = new Date();
		}

		await leaveRequest.save();

		// Update staff member status in team
		const staffMember = team.teamInfo.staff.find(s => 
			s.user.toString() === leaveRequest.staffMember._id.toString()
		);

		if (staffMember) {
			staffMember.leaveRequestStatus = leaveRequest.status;
			if (action === 'approve') {
				staffMember.isActive = false;
				staffMember.leftAt = new Date();
			}
			await team.save();
		}

		// Update player's joinedTeams status
		const player = await User.findById(leaveRequest.staffMember._id);
		if (player && player.userType === 'player') {
			const teamMembership = player.playerInfo.joinedTeams.find(
				teamRef => teamRef.team.toString() === teamId && teamRef.game === 'Staff'
			);
			if (teamMembership) {
				if (action === 'approve') {
					teamMembership.isActive = false;
					teamMembership.leftAt = new Date();
				}
				await player.save();
			}
		}

		const notification = {
			type: 'leave_request_response',
			title: `Leave Request ${action === 'approve' ? 'Approved' : 'Rejected'}`,
			message: `Your leave request has been ${action === 'approve' ? 'approved' : 'rejected'}`,
			data: { leaveRequestId: leaveRequest._id, teamId: teamId, teamName: team.profile.displayName, status: leaveRequest.status, adminResponse: adminResponse }
		};
		emitNotification(leaveRequest.staffMember._id, notification);

		return res.status(200).json({ success: true, message: `Leave request ${action === 'approve' ? 'approved' : 'rejected'} successfully`, data: { leaveRequest } });
	} catch (error) {
		console.error('Error responding to leave request:', error);
		return res.status(500).json({ success: false, message: 'Failed to respond to leave request', error: error.message });
	}
};

// Cancel leave request (staff member only)
const cancelLeaveRequest = async (req, res) => {
	try {
		const { teamId, requestId } = req.params;
		const staffMemberId = req.user._id;
		const leaveRequest = await LeaveRequest.findById(requestId);
		if (!leaveRequest || 
			leaveRequest.team.toString() !== teamId || 
			leaveRequest.staffMember.toString() !== staffMemberId.toString()) {
			return res.status(404).json({ success: false, message: 'Leave request not found' });
		}
		if (leaveRequest.status !== 'pending') {
			return res.status(400).json({ success: false, message: 'Leave request has already been processed' });
		}
		await LeaveRequest.findByIdAndDelete(requestId);
		const team = await User.findById(teamId);
		if (team) {
			const staffMember = team.teamInfo.staff.find(s => s.user.toString() === staffMemberId.toString());
			if (staffMember) {
				staffMember.leaveRequestStatus = 'none';
				await team.save();
			}
		}
		return res.status(200).json({ success: true, message: 'Leave request cancelled successfully' });
	} catch (error) {
		console.error('Error cancelling leave request:', error);
		return res.status(500).json({ success: false, message: 'Failed to cancel leave request', error: error.message });
	}
};

module.exports = { createLeaveRequest, getTeamLeaveRequests, getUserLeaveRequests, respondToLeaveRequest, cancelLeaveRequest };

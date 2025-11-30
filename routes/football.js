const express = require('express');
const router = express.Router();
const Team = require('../models/Team');
const Competition = require('../models/Competition');
const User = require('../models/User');
const auth = require('../middleware/auth');
const axios = require('axios');

const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = process.env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';

// Helper to make API-Sports requests
const apiSportsRequest = async (endpoint, params = {}) => {
    try {
        const response = await axios.get(`${BASE_URL}${endpoint}`, {
            params,
            headers: {
                'x-apisports-key': API_KEY,
            },
        });
        return response.data;
    } catch (error) {
        console.error(`❌ API-Sports request failed: ${endpoint}`, error.message);
        throw error;
    }
};

// ============================================================
// TEAMS ENDPOINTS
// ============================================================

// GET /api/football/teams - Search teams
router.get('/teams', async (req, res) => {
    try {
        const { search, country, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        let query = {};
        
        if (search) {
            // Use regex for partial matching (case insensitive)
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { country: { $regex: search, $options: 'i' } }
            ];
        }
        
        if (country) {
            query.country = { $regex: country, $options: 'i' };
        }

        const [teams, total] = await Promise.all([
            Team.find(query)
                .skip(skip)
                .limit(parseInt(limit))
                .sort({ name: 1 })
                .lean(),
            Team.countDocuments(query)
        ]);

        res.json({
            teams,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('❌ Error fetching teams:', error);
        res.status(500).json({ message: 'Failed to fetch teams', error: error.message });
    }
});

// GET /api/football/teams/popular - Get popular teams
router.get('/teams/popular', async (req, res) => {
    try {
        // Popular teams by API ID (can be extended)
        const popularTeamIds = [
            33, 34, 40, 42, 47, 49, 50, 51, // Premier League
            529, 530, 541, 157, // La Liga
            489, 492, 496, 497, 499, 505, // Serie A
            157, 165, 168, // Bundesliga
            2931, 2939, 2932, 2935, // UAE Pro League
            2939, 2944, // KSA Pro League (Al Nassr, Al Hilal)
        ];

        const teams = await Team.find({ apiId: { $in: popularTeamIds } })
            .sort({ name: 1 })
            .lean();

        res.json({ teams });
    } catch (error) {
        console.error('❌ Error fetching popular teams:', error);
        res.status(500).json({ message: 'Failed to fetch popular teams', error: error.message });
    }
});

// GET /api/football/teams/:id - Get team by ID
router.get('/teams/:id', async (req, res) => {
    try {
        const team = await Team.findById(req.params.id).lean();
        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }
        res.json(team);
    } catch (error) {
        console.error('❌ Error fetching team:', error);
        res.status(500).json({ message: 'Failed to fetch team', error: error.message });
    }
});

// ============================================================
// COMPETITIONS ENDPOINTS
// ============================================================

// GET /api/football/competitions - Search competitions
router.get('/competitions', async (req, res) => {
    try {
        const { search, country, type, page = 1, limit = 20 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        let query = {};
        
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { country: { $regex: search, $options: 'i' } }
            ];
        }
        
        if (country) {
            query.country = { $regex: country, $options: 'i' };
        }

        if (type) {
            query.type = type;
        }

        const [competitions, total] = await Promise.all([
            Competition.find(query)
                .skip(skip)
                .limit(parseInt(limit))
                .sort({ name: 1 })
                .lean(),
            Competition.countDocuments(query)
        ]);

        res.json({
            competitions,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('❌ Error fetching competitions:', error);
        res.status(500).json({ message: 'Failed to fetch competitions', error: error.message });
    }
});

// GET /api/football/competitions/popular - Get popular competitions
router.get('/competitions/popular', async (req, res) => {
    try {
        // Popular competitions by API ID
        const popularCompetitionIds = [
            39,   // Premier League
            140,  // La Liga
            135,  // Serie A
            78,   // Bundesliga
            61,   // Ligue 1
            2,    // UEFA Champions League
            3,    // UEFA Europa League
            301,  // UAE Pro League
            307,  // Saudi Pro League
            1,    // World Cup
        ];

        const competitions = await Competition.find({ apiId: { $in: popularCompetitionIds } })
            .sort({ name: 1 })
            .lean();

        res.json({ competitions });
    } catch (error) {
        console.error('❌ Error fetching popular competitions:', error);
        res.status(500).json({ message: 'Failed to fetch popular competitions', error: error.message });
    }
});

// GET /api/football/competitions/:id - Get competition by ID
router.get('/competitions/:id', async (req, res) => {
    try {
        const competition = await Competition.findById(req.params.id).lean();
        if (!competition) {
            return res.status(404).json({ message: 'Competition not found' });
        }
        res.json(competition);
    } catch (error) {
        console.error('❌ Error fetching competition:', error);
        res.status(500).json({ message: 'Failed to fetch competition', error: error.message });
    }
});

// ============================================================
// USER FOLLOW ENDPOINTS (Requires Auth)
// ============================================================

// GET /api/football/user/follows - Get user's followed teams and competitions
router.get('/user/follows', auth, async (req, res) => {
    try {
        const user = await User.findOne({ supabase_id: req.user.sub })
            .populate('followed_teams')
            .populate('followed_competitions')
            .lean();

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({
            teams: user.followed_teams || [],
            competitions: user.followed_competitions || []
        });
    } catch (error) {
        console.error('❌ Error fetching user follows:', error);
        res.status(500).json({ message: 'Failed to fetch follows', error: error.message });
    }
});

// POST /api/football/user/follow/team - Follow a team
router.post('/user/follow/team', auth, async (req, res) => {
    try {
        const { teamId } = req.body;
        
        if (!teamId) {
            return res.status(400).json({ message: 'teamId is required' });
        }

        // Verify team exists
        const team = await Team.findById(teamId);
        if (!team) {
            return res.status(404).json({ message: 'Team not found' });
        }

        const user = await User.findOneAndUpdate(
            { supabase_id: req.user.sub },
            { $addToSet: { followed_teams: teamId } },
            { new: true }
        ).populate('followed_teams');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({ 
            message: 'Team followed successfully',
            followed_teams: user.followed_teams 
        });
    } catch (error) {
        console.error('❌ Error following team:', error);
        res.status(500).json({ message: 'Failed to follow team', error: error.message });
    }
});

// DELETE /api/football/user/unfollow/team - Unfollow a team
router.delete('/user/unfollow/team', auth, async (req, res) => {
    try {
        const { teamId } = req.body;
        
        if (!teamId) {
            return res.status(400).json({ message: 'teamId is required' });
        }

        const user = await User.findOneAndUpdate(
            { supabase_id: req.user.sub },
            { $pull: { followed_teams: teamId } },
            { new: true }
        ).populate('followed_teams');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({ 
            message: 'Team unfollowed successfully',
            followed_teams: user.followed_teams 
        });
    } catch (error) {
        console.error('❌ Error unfollowing team:', error);
        res.status(500).json({ message: 'Failed to unfollow team', error: error.message });
    }
});

// POST /api/football/user/follow/competition - Follow a competition
router.post('/user/follow/competition', auth, async (req, res) => {
    try {
        const { competitionId } = req.body;
        
        if (!competitionId) {
            return res.status(400).json({ message: 'competitionId is required' });
        }

        // Verify competition exists
        const competition = await Competition.findById(competitionId);
        if (!competition) {
            return res.status(404).json({ message: 'Competition not found' });
        }

        const user = await User.findOneAndUpdate(
            { supabase_id: req.user.sub },
            { $addToSet: { followed_competitions: competitionId } },
            { new: true }
        ).populate('followed_competitions');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({ 
            message: 'Competition followed successfully',
            followed_competitions: user.followed_competitions 
        });
    } catch (error) {
        console.error('❌ Error following competition:', error);
        res.status(500).json({ message: 'Failed to follow competition', error: error.message });
    }
});

// DELETE /api/football/user/unfollow/competition - Unfollow a competition
router.delete('/user/unfollow/competition', auth, async (req, res) => {
    try {
        const { competitionId } = req.body;
        
        if (!competitionId) {
            return res.status(400).json({ message: 'competitionId is required' });
        }

        const user = await User.findOneAndUpdate(
            { supabase_id: req.user.sub },
            { $pull: { followed_competitions: competitionId } },
            { new: true }
        ).populate('followed_competitions');

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        res.json({ 
            message: 'Competition unfollowed successfully',
            followed_competitions: user.followed_competitions 
        });
    } catch (error) {
        console.error('❌ Error unfollowing competition:', error);
        res.status(500).json({ message: 'Failed to unfollow competition', error: error.message });
    }
});

// ============================================================
// SYNC ENDPOINTS (Admin/Background Jobs)
// ============================================================

// POST /api/football/sync/teams - Sync teams from API to database
router.post('/sync/teams', async (req, res) => {
    try {
        const { leagueId, season = 2024 } = req.body;

        if (!leagueId) {
            return res.status(400).json({ message: 'leagueId is required' });
        }

        console.log(`🔄 Syncing teams for league ${leagueId}, season ${season}...`);

        const response = await apiSportsRequest('/teams', { league: leagueId, season });
        
        if (!response.response || response.response.length === 0) {
            return res.status(404).json({ message: 'No teams found for this league/season' });
        }

        const teams = response.response;
        let created = 0;
        let updated = 0;

        for (const teamData of teams) {
            const teamDoc = {
                apiId: teamData.team.id,
                name: teamData.team.name,
                logo: teamData.team.logo,
                country: teamData.team.country,
                founded: teamData.team.founded,
                code: teamData.team.code,
                national: teamData.team.national,
                venueId: teamData.venue?.id,
                venueName: teamData.venue?.name,
                venueCity: teamData.venue?.city,
                venueCapacity: teamData.venue?.capacity,
            };

            const result = await Team.findOneAndUpdate(
                { apiId: teamData.team.id },
                teamDoc,
                { upsert: true, new: true }
            );

            if (result.createdAt === result.updatedAt) {
                created++;
            } else {
                updated++;
            }
        }

        console.log(`✅ Synced ${teams.length} teams (${created} created, ${updated} updated)`);
        res.json({ 
            message: `Synced ${teams.length} teams`,
            created,
            updated 
        });
    } catch (error) {
        console.error('❌ Error syncing teams:', error);
        res.status(500).json({ message: 'Failed to sync teams', error: error.message });
    }
});

// POST /api/football/sync/competitions - Sync competitions from API to database
router.post('/sync/competitions', async (req, res) => {
    try {
        const { country } = req.body;

        console.log(`🔄 Syncing competitions${country ? ` for ${country}` : ''}...`);

        const params = country ? { country } : {};
        const response = await apiSportsRequest('/leagues', params);
        
        if (!response.response || response.response.length === 0) {
            return res.status(404).json({ message: 'No competitions found' });
        }

        const competitions = response.response;
        let created = 0;
        let updated = 0;

        for (const compData of competitions) {
            const currentSeason = compData.seasons?.find(s => s.current);
            
            const compDoc = {
                apiId: compData.league.id,
                name: compData.league.name,
                type: compData.league.type,
                logo: compData.league.logo,
                country: compData.country?.name,
                countryCode: compData.country?.code,
                countryFlag: compData.country?.flag,
                currentSeason: currentSeason?.year,
                seasonStart: currentSeason?.start ? new Date(currentSeason.start) : null,
                seasonEnd: currentSeason?.end ? new Date(currentSeason.end) : null,
                standings: currentSeason?.coverage?.standings || false,
            };

            const result = await Competition.findOneAndUpdate(
                { apiId: compData.league.id },
                compDoc,
                { upsert: true, new: true }
            );

            if (result.createdAt === result.updatedAt) {
                created++;
            } else {
                updated++;
            }
        }

        console.log(`✅ Synced ${competitions.length} competitions (${created} created, ${updated} updated)`);
        res.json({ 
            message: `Synced ${competitions.length} competitions`,
            created,
            updated 
        });
    } catch (error) {
        console.error('❌ Error syncing competitions:', error);
        res.status(500).json({ message: 'Failed to sync competitions', error: error.message });
    }
});

// POST /api/football/sync/all - Sync all popular leagues teams and competitions
router.post('/sync/all', async (req, res) => {
    try {
        console.log('🔄 Starting full sync of teams and competitions...');

        // Popular leagues to sync
        const leagues = [
            { id: 39, name: 'Premier League', season: 2024 },
            { id: 140, name: 'La Liga', season: 2024 },
            { id: 135, name: 'Serie A', season: 2024 },
            { id: 78, name: 'Bundesliga', season: 2024 },
            { id: 61, name: 'Ligue 1', season: 2024 },
            { id: 301, name: 'UAE Pro League', season: 2024 },
            { id: 307, name: 'Saudi Pro League', season: 2024 },
            { id: 2, name: 'UEFA Champions League', season: 2024 },
        ];

        const results = {
            teams: { created: 0, updated: 0, total: 0 },
            competitions: { created: 0, updated: 0, total: 0 }
        };

        // Sync competitions first
        console.log('🔄 Syncing competitions...');
        const compResponse = await apiSportsRequest('/leagues');
        
        if (compResponse.response) {
            for (const compData of compResponse.response) {
                const currentSeason = compData.seasons?.find(s => s.current);
                
                const compDoc = {
                    apiId: compData.league.id,
                    name: compData.league.name,
                    type: compData.league.type,
                    logo: compData.league.logo,
                    country: compData.country?.name,
                    countryCode: compData.country?.code,
                    countryFlag: compData.country?.flag,
                    currentSeason: currentSeason?.year,
                    seasonStart: currentSeason?.start ? new Date(currentSeason.start) : null,
                    seasonEnd: currentSeason?.end ? new Date(currentSeason.end) : null,
                    standings: currentSeason?.coverage?.standings || false,
                };

                await Competition.findOneAndUpdate(
                    { apiId: compData.league.id },
                    compDoc,
                    { upsert: true }
                );
                results.competitions.total++;
            }
        }

        // Sync teams for each league
        for (const league of leagues) {
            console.log(`🔄 Syncing teams for ${league.name}...`);
            
            try {
                const response = await apiSportsRequest('/teams', { 
                    league: league.id, 
                    season: league.season 
                });
                
                if (response.response) {
                    for (const teamData of response.response) {
                        const teamDoc = {
                            apiId: teamData.team.id,
                            name: teamData.team.name,
                            logo: teamData.team.logo,
                            country: teamData.team.country,
                            founded: teamData.team.founded,
                            code: teamData.team.code,
                            national: teamData.team.national,
                            venueId: teamData.venue?.id,
                            venueName: teamData.venue?.name,
                            venueCity: teamData.venue?.city,
                            venueCapacity: teamData.venue?.capacity,
                        };

                        await Team.findOneAndUpdate(
                            { apiId: teamData.team.id },
                            teamDoc,
                            { upsert: true }
                        );
                        results.teams.total++;
                    }
                }
            } catch (error) {
                console.warn(`⚠️ Failed to sync teams for ${league.name}:`, error.message);
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        console.log(`✅ Full sync completed: ${results.teams.total} teams, ${results.competitions.total} competitions`);
        res.json({ 
            message: 'Full sync completed',
            results 
        });
    } catch (error) {
        console.error('❌ Error during full sync:', error);
        res.status(500).json({ message: 'Failed to complete sync', error: error.message });
    }
});

module.exports = router;

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let inMemoryServer = null;
let hasTriedInMemory = false;

const connectToMongoUri = async (uri) => {
	return mongoose.connect(uri, {
		maxPoolSize: 10,
		serverSelectionTimeoutMS: 5000,
		socketTimeoutMS: 45000,
		retryWrites: true,
		w: 'majority',
		minPoolSize: 1,
		maxIdleTimeMS: 30000,
		connectTimeoutMS: 10000,
		heartbeatFrequencyMS: 10000
	});
};

const startInMemoryMongo = async () => {
	if (hasTriedInMemory) return;
	hasTriedInMemory = true;
	try {
		inMemoryServer = await MongoMemoryServer.create();
		const uri = inMemoryServer.getUri();
		await connectToMongoUri(uri);
		console.log(`MongoDB (in-memory) Connected: ${uri}`);
		setupConnectionEventHandlers();
		setupGracefulShutdown();
	} catch (err) {
		console.error('Failed to start in-memory MongoDB:', err);
		throw err;
	}
};

const setupConnectionEventHandlers = () => {
	mongoose.connection.on('error', (err) => {
		console.error('MongoDB connection error:', err);
	});

	mongoose.connection.on('disconnected', () => {
		console.log('MongoDB disconnected');
	});

	mongoose.connection.on('reconnected', () => {
		console.log('MongoDB reconnected');
	});
};

const setupGracefulShutdown = () => {
	process.on('SIGINT', async () => {
		try {
			await mongoose.connection.close();
			if (inMemoryServer) {
				await inMemoryServer.stop();
			}
			console.log('MongoDB connection closed through app termination');
			process.exit(0);
		} catch (err) {
			console.error('Error closing MongoDB connection:', err);
			process.exit(1);
		}
	});
};

const connectDB = async () => {
	try {
		const conn = await connectToMongoUri(process.env.MONGODB_URI);
		console.log(`MongoDB Connected: ${conn.connection.host}`);
		setupConnectionEventHandlers();
		setupGracefulShutdown();
	} catch (error) {
		console.error('Database connection error:', error.message);
		console.error('Full error details:', error);

		if (error.message.includes('Invalid connection string')) {
			console.error('Please check your MONGODB_URI environment variable');
		}

		const allowInMemory = process.env.ALLOW_IN_MEMORY_DB !== 'false';
		if (allowInMemory) {
			console.log('Attempting to start in-memory MongoDB as fallback...');
			await startInMemoryMongo();
			return;
		}

		setTimeout(() => {
			console.log('Retrying database connection...');
			connectDB();
		}, 5000);
	}
};

module.exports = connectDB;

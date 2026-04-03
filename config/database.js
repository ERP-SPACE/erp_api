const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    const connectionString = process.env.MONGODB_URI;

    if (!connectionString) {
      throw new Error("MONGODB_URI is not set");
    }

    const conn = await mongoose.connect(connectionString, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // Create indexes
    await createIndexes();
  } catch (error) {
    console.error(`MongoDB Connection Error: ${error.message}`);

    // Provide helpful error messages
    if (error.message.includes('ECONNREFUSED')) {
      console.error('\n🔧 MongoDB Connection Failed!');
      console.error('Please ensure MongoDB is running:');
      console.error('1. Install MongoDB locally (see install-mongodb.ps1)');
      console.error('2. Or use MongoDB Atlas with proper credentials');
      console.error('3. Or set MONGODB_URI environment variable');
      console.error('\nFor local MongoDB:');
      console.error('- Run: mongod --dbpath "C:\\data\\db"');
      console.error('- Or install MongoDB service');
    }

    process.exit(1);
  }
};

const createIndexes = async () => {
  try {
    // Indexes will be created in model files
    console.log("Database indexes ensured");
  } catch (error) {
    console.error("Error creating indexes:", error);
  }
};

module.exports = connectDB;

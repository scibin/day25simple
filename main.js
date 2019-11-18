// load libraries
const fs = require('fs');
const mysql = require('mysql');
const express = require('express');
const morgan = require('morgan');
// const hbs = require('express-handlebars');
const path = require('path');
const uuid = require('uuid');
const cors = require('cors');

const multer = require('multer');
const aws = require('aws-sdk');

const db = require('./dbutil');

const dbConfigPath = __dirname + '/config.js';
const s3ConfigPath = __dirname + '/s3config.js';

// Config file for MySQL createPool parameters 
let dbConfig;
let s3Config;

if (fs.existsSync(dbConfigPath)) {
    dbConfig = require(dbConfigPath);
    dbConfig.ssl = {
        ca: fs.readFileSync(dbConfig.cacert)
    };
} else {
    dbConfig = {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: 'mynews',
        connectionLimit: 4,
        ssl: {
            ca: process.env.DB_CA
        }
    };
}

// AWS config

// Check if s3config file exists - if not, use env variables
if (fs.existsSync(s3ConfigPath)) {
    s3Config = require(s3ConfigPath);
} else {
    s3Config = {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY
    }
}

// Create new instance of s3
const DO_SPACE_URL = 'sgp1.digitaloceanspaces.com';
const s3 = new aws.S3({
    endpoint: new aws.Endpoint(DO_SPACE_URL),
    accessKeyId: s3Config.accessKeyId,
    secretAccessKey: s3Config.secretAccessKey
});
const bucketName = 'abc1234';

// PORT and POOl configuration
const pool = mysql.createPool(dbConfig);
const PORT = parseInt(process.argv[2] || process.env.APP_PORT || process.env.PORT) || 3000;

// Multer - note the '/dirName/' --> if using path.join, 'dirName/' works too
// NOTE: Empty directories will not be git checked in --> put .gitkeep in empty folder
const upload = multer({ dest: path.join(__dirname, '/tmp/') });


// SQL query phrases

// [ art_id, title, email, article, posted_date, img_url ]
const qp_INSERT_NEW_ARTICLE = 'insert into articles(art_id, title, email, article, posted, image_url) values (?, ?, ?, ?, ?, ?)';

// SQL statements
const insertNewArticle = db.mkQuery(qp_INSERT_NEW_ARTICLE);



// Start the application
const app = express();

// CORS
app.use(cors());

// Handlebars
// app.engine('hbs', hbs({ defaultLayout: 'main.hbs' }));
// app.set('view engine', 'hbs');
// app.set('views', path.join(__dirname, 'views'));

// Serve static folders
app.use(express.static(path.join(__dirname, 'public')));
// app.use(express.static(path.join(__dirname, 'tmp')));

// Morgan
app.use(morgan('tiny'));



// Handle requests here

// Upload a file
// insertNewArticle
app.post('/api/upload/article', upload.single('myImage'), (req, res) => {
    // Insert article into DB, upload picture onto DO Spaces
    pool.getConnection((err, conn) => {
        if (err) {
            return res.status(500).type('text/plain').send(`Error ${err}`);
        }
        db.startTransaction(conn)
            .then(status => {
                // uuid format is e0c0dc15-6194-4878-8033-5d7c10b3a21c
                // too long, so take only the first 8 chars
                const art_id = uuid().substring(0, 8);
                const postDate = new Date();
                const queryArray = [art_id, req.body.title, req.body.email, req.body.article, postDate, req.file.filename];
                return (insertNewArticle({
                    connection: status.connection,
                    params: queryArray
                }));
            })
            // Upload file to DigitalOcean Spaces
            // abc1234 in this case
            // Filename
            // https://abc1234.sgp1.digitaloceanspaces.com/background-image.jpg
            .then(status =>
                new Promise((resolve, reject) => {
                    fs.readFile(req.file.path, (err, imgFile) => {
                        if (err) {
                            return reject({ connection: status.connection, error: err });
                        }
                        // Config: Bucket abc1234, public can access
                        const params = {
                            Bucket: bucketName,
                            // Save it under the articles 'folder'
                            // Filename already encrypted via html post
                            // DO doesn't encrypt filenames
                            Key: `articles/${req.file.filename}`,
                            Body: imgFile,
                            ACL: 'public-read',
                            ContentType: req.file.mimetype,
                            ContentLength: req.file.size,
                            Metadata: {
                                originalName: req.file.originalname,
                                update: '' + (new Date()).getTime()
                            }
                        };
                        s3.putObject(params, (error, result) => {
                            if (error) {

                                return reject({ connection: status.connection, error: error });
                            }
                            resolve({ connection: status.connection, result: result });
                        })
                    })
                })
            )
            //.then(db.passthru, db.logError)
            // Is the same as .then(db.commit).catch(db.rollback)
            .then(db.commit, db.rollback)
            // Can do this either before or after .then(db.commit, db.rollback)
            .then(
                // Successful
                (status) =>
                    new Promise((resolve, reject) => {
                        fs.unlink(req.file.path, () => {
                            res.status(201).json({ status: `Posted article ${req.body.title}` });
                            // res.status(201).type('text/plain')
                            // .send(`Posted article ${req.body.title}`);

                        })
                    })
                ,
                // Failed
                (status) => {
                    // In the case of failure, file is not unlinked
                    // .send(`Error in uploading article ${status.error}`);
                    res.status(400).json({ status: `Error! ${status.error}` });
                }
            )
            .finally(() => conn.release());
    })
})

// Get all images using s3 listObjects from the articles folder
app.get('/api/get/images/all', (req, res) => {

    const params = {
        Bucket: bucketName,
        MaxKeys: 99
    };
    s3.listObjects(params, (err, data) => {
        if (err) {
            res.status(500).json({ error: err });
        }
        const imgURLArray = [];
        data.Contents.map(v => {
            // Get only image files from the articles folder
            if (v.Key.includes('articles/')) {
                imgURLArray.push(`https://${bucketName}.${DO_SPACE_URL}/${v.Key}`);
            }
        })
        // Returns an array of image urls and the bucket name
        res.status(200).json({ urls: imgURLArray, bucketName: data.Name });
    })
})

// Upload multiple files to miscimages folder
app.post('/api/upload/images', upload.any(), (req, res) => {
    // For multiple files, files are in req.files instead of req.file
    // Upload files one by one using fs.readFile + s3.putObject
    req.files.map(v => {
        fs.readFile(v.path, (err, imgFile) => {
            if (err) {
                res.status(500).json({ error: err }); 
            }
            // Config: Bucket abc1234, public can access
            const params = {
                Bucket: bucketName,
                Key: `miscimages/${v.filename}`,
                Body: imgFile,
                ACL: 'public-read',
                ContentType: v.mimetype,
                ContentLength: v.size,
                Metadata: {
                    originalName: v.originalname,
                    update: '' + (new Date()).getTime()
                }
            };
            s3.putObject(params, (error, result) => {
                if (error) {
                    res.status(500).json({ error: err });
                }
            })
        })
        // Unlink/delete files in tmp folder
        fs.unlink(v.path, () => {});
    })
    res.status(200).json({ status: 'Files uploaded!' });
})



// // !!! Practice if there is time

// // Get all articles information
// app.get('/api/get/articles/all' , (req, res) => {
//     // !!! getAllArticles not yet initiated
//     getAllArticles()
//         .then(result => {
//             res.status(200).type('text/html')
//                 .render('articles', { articles: result });
//         })
//         .catch(error => {
//             //
//         })
// })

// // Retriving a file from DigitalOcean Spaces

// // TRY? /api/get/:images/:id
// // Retrieve encrypted key name from SQL,
// // Pass it into params.Key

// app.get('/.............../:id', (req, res) => {
//     // Set the parameters
//     const id = req.param.id;
//     const params = {
//         Bucket: bucketName,
//         Key: '_________________________'
//     };
//     // Get object from DigitalOcean Spaces
//     s3.getObject(params, (err, result) => {
//         // There is result.ContentType, result.Metadata, result.Body
//         // Do stuff
//     });
//     // Response
//     res.status(200).json({});
// })




// Catch-all


// Get connection
pool.getConnection(
    (err, conn) => {
        if (err) {
            console.error('Cannot get database: ', err);
            return process.exit(0);
        }
        conn.ping((err) => {
            conn.release();
            if (err) {
                console.error('Cannot ping database: ', err);
                return process.exit(0);
            }
            app.listen(PORT,
                () => {
                    console.info(`Application stared on ${PORT} at ${new Date().toString()}`);
                }
            )
        })
    }
)

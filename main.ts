import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import {callDeepseek} from "./resources/deepseek.js"
import {countryListAlpha2} from "./resources/country-list.js"
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui'
import 'dotenv/config'

//> Redis imports and config 
import {createClient} from 'redis';
const client = createClient();
client.on('error', err => console.log('Redis Client Error', err));


const fastify = Fastify({
    logger: {
        transport:{
            target: "pino-pretty"
        },
    },
})

//> testing redis, logs value


// fastify.get('/', async function () {
//     return{message:"Hello world"};
// });

fastify.post("/api/users", {
    handler: async (request: FastifyRequest, reply: FastifyReply) => {

        fastify.log.info("bingbongbingbongbingbongbingbongbingbongbingbong"); // fastify.log.info needs to be used for printing in fastify
        return reply.code(201).send("User created");
    },
});



// this function can be deleted or changed, it was just for initially testing calling the weather API. 
fastify.get("/", {
    handler: async () => {

        const open_weather_map_key = process.env.open_weather_map_key

        
        const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=Paris,FR&appid=${open_weather_map_key}`); // calls API, waits for response
        const data = await response.json(); // converts response contents to .json

        const city = data.name;
        const temp = data.main.temp;
        const temp_celsius = Math.round(temp-273.15)
        fastify.log.info(`It is ${temp_celsius} degrees in ${city}`)

        return {message: data}
    }
});

// fastify.get("/outfit", async function() {
//     return{message:"Looks fly bro"};
// });

// Request = incoming data into application 
// Reply = the application's outgoing response. 
// Currently, data sent to POST function isnt being persisted anywhere (no database connected yet).

async function main() {
    await fastify.register(fastifySwagger, {
        openapi: {
            info: {
                title: 'Weather Outfit API',
                version: '1.0.0'
            }
        }
    });

    await fastify.register(fastifySwaggerUi, {
        routePrefix: '/docs',
    });
 


    await client.connect();


    fastify.post("/api/fetch-weather", {
        schema: { // this schema is required by swagger, specifies what inputs the swagger UI needs to pass. 
            body: {
                type: 'object',
                required:['city', 'country', 'gender'],
                properties:{
                    city:{type:'string', examples:['Melbourne']},
                    country:{type:'string', examples:['Australia']},
                    gender:{type:'string',
                        enum:['Male', 'Female', 'Unisex']
                    }
                }
            }
        },
        handler:async(request:FastifyRequest<{
            Body:{
                country:string;
                city:string;
                gender:string,
            };
        }>, reply:FastifyReply) => {
    
    
            await client.set('key', 'value'); // sets key:value pair, caches it using redis
            const value = await client.get('key'); // redis uses the key to fetch the value, stores this in value
            fastify.log.info(value); // redis logs the contents of value, which is the value from the original key:value pair


            try {

                const open_weather_map_key = process.env.open_weather_map_key
                const r_country = request.body.country; // country name provided by user
                const r_city = request.body.city; // city provided by user
                const r_gender = request.body.gender; // gender provided by user
                const country_code = (Object.keys(countryListAlpha2).find(key => countryListAlpha2[key].toLowerCase() === r_country.toLowerCase()) ?? "Empty")
                if (country_code === "Empty") {
                    throw new Error(`User has entered a country not stored in database.`) 




                // line 103 iterates through hashmap of country_codes:country_names to fetch country code
                // Object.keys(countryListAlpha2) specifies we're returning the keys (Object is needed because Hashmaps are objects in Javascript)
                // .find(key => countryListAlpha[key]) tells the lambda to iterate through all key:value pairs in countryListAlpha2
                // countryListAlpha2[key] returns the value from the key:value pair its pointing to
                // countryListAlpha2[key].toLowerCase() === r_country.toLowerCase() compares the value against r_country (country name) in lowercase
                // Object.keys() specifies that this look is to return the key, not the value in the key:value pair.
                // Object.values(hashmap) returns values
                // Object.entries(hashmap) returns full key:value pair

                // write loop to check country user has provided against countrys in countryListAlpha2 to ensure they've provided a country the 
                // app can lookup in the weather API. 

               
                }


                await client.set(`${r_city} ${country_code}`, 'Already stored') 

     
                const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${r_city},${country_code}&appid=${open_weather_map_key}`); // calls weather API
    
                // if i have to use country codes, make a seperate file with a dictionary converting country names into the country code
                // ease of use measure, makes it cleaner and easier to specify country, looking up the code for every call is stupid. 
    
                if (!response.ok) {
                    throw new Error(`Weather API call failed, responded with status: ${response.status}`);
                }
                // catches failed api calls
    
                const data = await response.json(); // converts incoming weather API data into .json so I can access data
                const temp = data.main.temp; // fetches temp (temperature) from API call data
                const temp_in_celsius = Math.round(temp-273.15) // converts the temperature from kelvin to celsius      
                const city = data.name; // fetches city from API call data
                const description = data.weather[0].description; // fetches description from API call data
                const humidity = data.main.humidity;

                const clothing = await callDeepseek(`Recommend a culturally appropriate, weather appropriate, 
                    ${r_gender} outfit for someone in ${r_city}, ${r_country} including top, 
                    bottom and shoes for ${temp_in_celsius} degrees celsius and ${description} at ${humidity}% humidity` 
                    );

                const lowercase_clothing = (clothing ?? "Empty").toLowerCase()
                // (clothing ?? '') defines the variable to empty if it is null when you try to call it. 

                const weather_and_outfit_recommendation = (`It is ${temp_in_celsius}°C with ${description} in ${city}, ${r_country} right now. My recommendation: ${clothing}`)
    
                fastify.log.info(weather_and_outfit_recommendation); // prints output to terminal, this is for logging and testing. 
                return reply.code(200).send(weather_and_outfit_recommendation); // return statement for this function, this is for the frontend. 
    
            } catch (error) {

                // when catching errors, use error.message (allows you to extract error message you threw)
                // use .includes to check the message's contents, use this to specify which error you're handling.

                if (error.message.includes("country not stored in database")) {
                    return reply.code(422).send({
                        statusCode: 422,
                        error: "User entered a country not stored in the database, please check spelling.",
                    })
                }
                // error code 422 means Unprocessable Entity (no syntax error occured but input was semantically wrong)
                // reply is what is returned by the function, so status code is sent as part of the reply. 
                // remember: request is what comes in, reply is what goes out.

                if (error.message.includes("Weather API call failed")) {
                    return reply.code(422).send({
                        statusCode:422,
                        error: "User entered a city not stored in the database, please check spelling.",
                    })
                }

                if (error.message.includes("unisex")) {
                    return reply.code(422).send({
                        statusCode:422,
                        error:"User entered incorrect gender option. I'm unsure how because choices are enforced. Well done. *Slow clap*"
                    })
                }

                // message is an attribute of error
                // error.message contains the message from when you threw the error.



                fastify.log.error(error);
                return reply.code(500).send({error: "Error caught, check log for more details."})
            }
            // curl -X POST http://localhost:3000/api/fetch-weather -H "Content-Type: application/json" -d '{"country": "AU", "city": "melbourne"}' -w "\n"
            // above is the curl request for testing this endpoint
    
            // call API, cache it using redis
            // if redis_weather_cache:
                // pull weather data from cache
            // else:
                // call API directly and cache it
        }
    });

    await fastify.listen({
        port: 3000,
        host: "0.0.0.0"
    });
}

// causes server to shutdown gracefully and restart when changes are made to the code while the server is running. 
["SIGINT", "SIGTERM"].forEach((signal) => {
    process.on(signal, async () => {
        await fastify.close();

        process.exit(0);
    })
});

main();


//start app: yarn tsx main.ts 

// Plan:

    // Integrate external weather API  [COMPLETE] [14/05/2026]
    // Integrate Deepseek to take weather and recommend an outfit with friendly message. [COMPLETE] [14/05/2026]
    // Push this app to github. [COMPLETE] [15/05/2026]
    // Add country code dictionary to enable fetch-weather to take in country names, convert them to codes (ie. AU, FR) to pass to open weather API  [COMPLETE] [15/06/2026]
    // Remove clothing colour recommendations to make outfit suggestions more widely applicable [COMPLETE] [24/05/2026]
    // Switch yo Yarn as exclusive package manager to prevent npm/yarn conflicts [COMPLETE] [24/05/2026]
    // Integrate Redis to cache weather API calls [IN PROGRESS] [24/05/2026]

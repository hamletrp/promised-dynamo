var AWS = require( 'aws-sdk' );
var Q = require( 'q' );

/*
 * TODO: Harmony Support
 *
 * 1) Auto configuration of tables in Harmony ( ?determine if this is desirable )
 * 2) Iterators over gets for continuations
 */

/*
 * TODO: Continuation support for queries and scans
 */

var mapDynamoObjectToJavascriptObject = function( item ) {

    if ( !item ) {
        return null;
    }

    var o = {};

    var mapProperty = function( currentProperty ) {
        if ( currentProperty[ 'S' ] ) {
            return currentProperty.S;
        }
        else if ( currentProperty[ 'SS' ] ) {
            return currentProperty.SS;
        }
        else if ( currentProperty[ 'BOOL' ] ) {
            return currentProperty.BOOL;
        }
        else if ( currentProperty[ 'N' ] ) {
            return Number( currentProperty.N );
        }
        else if ( currentProperty[ 'NS' ] ) {
            return currentProperty.NS.map( function( currentNumber ) {
                return Number( currentNumber );
            } );
        }
        else if ( currentProperty[ 'B' ] ) {
            return new Buffer( currentProperty.B, 'base64' );
        }
        else if ( currentProperty[ 'BS' ] ) {
            return currentProperty.BS.map( function( currentBinary ) {
                return new Buffer( currentBinary, 'base64' );
            } );
        }
        else if ( currentProperty[ 'L' ] ) {
            return currentProperty.L.map( mapProperty );
        }
        else if ( currentProperty[ 'M' ] ) {
            return mapDynamoObjectToJavascriptObject( currentProperty.M );
        }
    };

    for ( key in item ) {
        if ( item.hasOwnProperty( key ) ) {
            var currentProperty = item[ key ];

            o[ key ] = mapProperty( currentProperty );

            //TODO: Handle NULL
        }
    }

    return o;

};

var mapDynamoObjectsToJavascriptObjects = function( items ) {
    return items.map( mapDynamoObjectToJavascriptObject );
};

var mapJavascriptObjectToDynamoObject = function( item ) {

    //TODO: Handle NULL types
    if ( !item ) {
        return null;
    }

    var o = {};

    for ( key in item ) {
        if ( item.hasOwnProperty( key ) ) {
            var currentProperty = item[ key ];

            if ( typeof currentProperty === 'string' ) {
                o[ key ] = { "S": currentProperty };
            }
            else if ( typeof currentProperty === 'number' ) {
                o[ key ] = { "N": currentProperty.toString() };
            }
            else if ( typeof currentProperty === 'boolean' ) {
                o[ key ] = { "BOOL": currentProperty };
            }
            else if ( Array.isArray( currentProperty ) ) {
                if ( currentProperty.length ) {
                    //TODO: The way this is coded there would be no way to handle lists of strings or lists of numbers
                    //TODO: Deal with lists which are not homogeneous
                    if ( typeof currentProperty[ 0 ] === 'string' ) {
                        o[ key ] = { "SS": currentProperty };
                    }
                    else if ( typeof currentProperty[ 0 ] === 'number' ) {
                        o[ key ] = { "NS": currentProperty.map( function( currentValue ) { return currentValue.toString() } ) };
                    }
                    else {
                        if ( typeof currentProperty[ 0 ] === 'object' ) {
                            if ( currentProperty[ 0 ] instanceof Buffer ) {
                                o[ key ] = { "BS": currentProperty.map( function( currentValue ) {
                                    return currentValue.toString( 'base64' );
                                } ) };
                            }
                            else {
                                o[key] = {
                                    "L": currentProperty.map(function (currentListEntry) {
                                        return {
                                            "M": mapJavascriptObjectToDynamoObject(currentListEntry)
                                        }
                                    })
                                };
                            }
                        }
                    }
                    //TODO: Handle other list types
                }
                else {
                    //TODO: Evaluate appropriateness of this handling - List is being used, because empty sets are not allowed
                    o[ key ] = { "L": [] };
                }
            }
            else if ( currentProperty instanceof Buffer ) {
                //TODO: Deal with trailing =
                o[ key ] = { "B": currentProperty.toString( 'base64' ) };
            }
            else if ( typeof currentProperty === 'object' ) {
                o[ key ] = { "M": mapJavascriptObjectToDynamoObject( currentProperty ) };
            }
        }
    }

    return o;

};

/**
 * Example Condition Definition (with all the bells and whistles)
 *
 * {
 *   userId: 5, //where key = 5
 *   createdDate: {
 *     ">": 1427517440482
 *   }, //createdDate > 1427517440482
 *   OR: [
 *      { name: "tacos" },
 *      { type: "tex-mex" },
 *      { AND: [
 *          { type: "mexican" },
 *          { region: "america" }
 *        ]
 *      }
 *   ], //either name = tacos OR type = tex-mex OR ( type = mexican AND region = america )
 *   mealType: {
 *      IN: [ "lunch", "dinner" ]
 *   }, //mealType is one of "lunch" or "dinner"
 *   rating: {
 *      BETWEEN: [ 3, 5 ]
 *   }, //rating is between 3 and 5
 *   NOT: {
 *      active: false
 *   }, //it is NOT the case that the active property = false
 *   title: {
 *      STARTS_WITH: "The Best" //TODO: Functions like STARTS_WITH need to be implemented
 *   }
 * }
 *
 * See http://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.SpecifyingConditions.html#Expressions.SpecifyingConditions.ConditionExpressions
 * for more information concerning Condition Expressions
 *
 * @param conditionDefinition
 * @returns {{conditionExpression, expressionAttributeNames: {}, expressionAttributeValues}}
 */
var mapConditionDefinitionToConditionExpression = function( conditionDefinition, valueCountStart, nameCountStart ) {

    var expressionAttributeNames = {},
        namesForExpressionAttributes = {},
        expressionAttributeValues = {},
        valuesForExpressionAttributes = {},
        expressionAttributeValuesCount = valueCountStart || 1,
        expressionAttributeNamesCount = nameCountStart || 1;

    var writeOperatorExpression = function( conditionKey, operator, values ) {

        switch( operator ) {
            case '=':
            case '>':
            case '>=':
            case '<':
            case '<=':
            case '<>':
                if ( !valuesForExpressionAttributes[ values ] ) {
                    valuesForExpressionAttributes[ values ] = ':' + expressionAttributeValuesCount;
                    expressionAttributeValues[ ':' + expressionAttributeValuesCount ] = values;
                    expressionAttributeValuesCount += 1;
                }
                return namesForExpressionAttributes[ conditionKey ] + ' ' + operator + ' ' + valuesForExpressionAttributes[ values ];
            case 'IN':
                if ( !Array.isArray( values ) ) {
                    throw Error( 'IN statement for key ' + conditionKey + ' does not have an Array value' );
                }

                var valuePlaceholders = [];

                values.forEach( function( currentValue ) {
                    if ( !valuesForExpressionAttributes[ currentValue ] ) {
                        valuesForExpressionAttributes[ currentValue ] = ':' + expressionAttributeValuesCount;
                        expressionAttributeValues[ ':' + expressionAttributeValuesCount ] = currentValue;
                        expressionAttributeValuesCount += 1;
                    }

                    valuePlaceholders.push( valuesForExpressionAttributes[ currentValue ] );
                } );

                return namesForExpressionAttributes[ conditionKey ] + ' IN (' + valuePlaceholders.join( ', ' ) + ')';
            case 'BETWEEN':
                if ( !Array.isArray( values ) || values.length != 2 ) {
                    throw Error( 'BETWEEN statement for key ' + conditionKey + ' requires two values in an array' );
                }

                var betweenValuePlaceholders = [];

                values.forEach( function( currentValue ) {
                    if ( !valuesForExpressionAttributes[ currentValue ] ) {
                        valuesForExpressionAttributes[ currentValue ] = ':' + expressionAttributeValuesCount;
                        expressionAttributeValues[ ':' + expressionAttributeValuesCount ] = currentValue;
                        expressionAttributeValuesCount += 1;
                    }

                    betweenValuePlaceholders.push( valuesForExpressionAttributes[ currentValue ] );
                } );

                return namesForExpressionAttributes[ conditionKey ] + ' BETWEEN ' + betweenValuePlaceholders[ 0 ] + ' AND ' + betweenValuePlaceholders[ 1 ];
            case 'CONTAINS':
                if ( !valuesForExpressionAttributes[ values ] ) {
                    valuesForExpressionAttributes[ values ] = ':' + expressionAttributeValuesCount;
                    expressionAttributeValues[ ':' + expressionAttributeValuesCount ] = values;
                    expressionAttributeValuesCount += 1;
                }

                return 'contains ( ' + namesForExpressionAttributes[ conditionKey ] + ', ' + valuesForExpressionAttributes[ values ] + ' )';
            case 'begins_with':
                if ( !valuesForExpressionAttributes[ values ] ) {
                    valuesForExpressionAttributes[ values ] = ':' + expressionAttributeValuesCount;
                    expressionAttributeValues[ ':' + expressionAttributeValuesCount ] = values;
                    expressionAttributeValuesCount += 1;
                }

                return 'begins_with ( ' + namesForExpressionAttributes[ conditionKey ] + ', ' + valuesForExpressionAttributes[ values ] + ' )';
            case 'attribute_exists':
                return 'attribute_exists ( ' + namesForExpressionAttributes[ conditionKey ] + ' )';
            case 'attribute_not_exists':
                return 'attribute_not_exists ( ' + namesForExpressionAttributes[ conditionKey ] + ' )';
            default:
                throw new Error( 'Invalid operator ' + operator + ' for key ' + conditionKey );
        }
    };

    /**
     * An operatorDefinition will take the form of
     *
     * {
     *   ">": 5,
     *   "<>": 10,
     *   etc...
     * }
     *
     * Each operator in an operatorsDefinition is implicitly ANDed
     *
     * @param conditionKey
     * @param operatorsDefinition
     */
    var mapOperatorsObjectToConditionExpression = function( conditionKey, operatorsDefinition ) {

        var operations = [];

        for ( var currentOperator in operatorsDefinition ) {
            if ( operatorsDefinition.hasOwnProperty( currentOperator ) ) {
                operations.push( writeOperatorExpression( conditionKey, currentOperator, operatorsDefinition[ currentOperator ] ) );
            }
        }

        if ( operations.length === 1 ) {
            return operations[ 0 ];
        }

        return '( ' + operations.join( ' AND ' ) + ' )';

    };

    var mapCompositeExpressionDefinitionToConditionExpression = function( compositionType, composedExpressionDefinitions ) {

        var expressions = [];

        composedExpressionDefinitions.forEach( function( currentComposedExpressionDefinition ) {
            var currentExpressions = [];

            for ( var conditionKey in currentComposedExpressionDefinition ) {
                if ( currentComposedExpressionDefinition.hasOwnProperty( conditionKey ) ) {
                    currentExpressions.push( mapExpressionDefinitionToConditionExpression( conditionKey, currentComposedExpressionDefinition[ conditionKey ] ) );
                }
            }

        } );

        return '( ' + expressions.join( ' ' + compositionType + ' ' ) + ' )';

    };

    var mapNotExpressionDefinitionToConditionExpression = function( expressionDefinition ) {

        var expressions = [];

        for ( var conditionKey in expressionDefinition ) {
            if ( expressionDefinition.hasOwnProperty( conditionKey ) ) {
                expressions.push( mapExpressionDefinitionToConditionExpression( conditionKey, expressionDefinition[ conditionKey ] ) );
            }
        }

        if ( expressions.length === 1 ) {
            return 'NOT ' + expressions[ 0 ];
        }

        return 'NOT ( ' + expressions.join( ' AND ' ) + ' )';

    };

    var mapExpressionDefinitionToConditionExpression = function( conditionKey, expressionDefinition ) {

        //Check if the key is a special key
        if ( conditionKey == 'AND' || conditionKey == 'OR' ) {
            return mapCompositeExpressionDefinitionToConditionExpression( conditionKey, expressionDefinition );
        }
        if ( conditionKey == 'NOT' ) {
            return mapNotExpressionDefinitionToConditionExpression( expressionDefinition );
        }

        if ( !namesForExpressionAttributes[ conditionKey ] ) {
            namesForExpressionAttributes[ conditionKey ] = conditionKey.split( '.').map( function( currentNamePart ) {
                var newNamePart = '#N' + expressionAttributeNamesCount;
                expressionAttributeNames[ newNamePart ] = currentNamePart;
                expressionAttributeNamesCount += 1;

                return newNamePart;
            } ).join( '.' );

            /*
             namesForExpressionAttributes[ conditionKey ] = '#' + expressionAttributeNamesCount;
             expressionAttributeNames[ '#' + expressionAttributeNamesCount ] = conditionKey;
             expressionAttributeNamesCount += 1;
             */
        }

        if ( typeof expressionDefinition === 'object' ) {
            return mapOperatorsObjectToConditionExpression( conditionKey, expressionDefinition );
        }

        return writeOperatorExpression( conditionKey, '=', expressionDefinition );

    };

    var expressions = [];
    for ( var conditionKey in conditionDefinition ) {
        if ( conditionDefinition.hasOwnProperty( conditionKey ) ) {
            expressions.push( mapExpressionDefinitionToConditionExpression( conditionKey, conditionDefinition[ conditionKey ] ) );
        }
    }

    return {
        conditionExpression: expressions.join( ' AND ' ),
        expressionAttributeNames: expressionAttributeNames,
        expressionAttributeValues: mapJavascriptObjectToDynamoObject( expressionAttributeValues )
    };

};
/*
 * Simple SETs
 * { a : 1, b : 2 }
 *
 * Removal
 * { REMOVE : attrName }
 *
 * Addition
 * { ADD : { a : 1 } } or { ADD : { a : [ 1, 2 ] } }
 *
 * Deletion
 * { DELETE : { a : [ 1, 2 ] } }
 */
var mapUpdatesToUpdateExpression = function( updates, updateCondition ) {

    //TODO: Handle operations other than SET and ADD in some way
    var updateExpressions = {};
    var expressionAttributeValues = {};
    var expressionAttributeNames = {};

    var i = 1;
    var n = 1;

    var mapNameToExpressionAttributeName = function( name ) {
        return name.split( '.' ).map( function( currentNamePart ) {
            var newNamePart = '#N' + n;
            expressionAttributeNames[ newNamePart ] = currentNamePart;
            n++;
            return newNamePart;
        } ).join( '.' );
    };

    var addToUpdateExpressions = function( type, expression, addition ) {
        if ( !updateExpressions[ type ] ) {
            updateExpressions[ type ] = [];
        }

        if ( type === 'REMOVE' ) {
            if ( Array.isArray( addition ) ) {
                addition.forEach( function( currentRemoval ) {
                    updateExpressions[ type].push( mapNameToExpressionAttributeName( currentRemoval ) );
                } );
            }
            else {
                updateExpressions[type].push(mapNameToExpressionAttributeName(addition));
            }
            return;
        }

        for ( var key in addition ) {
            if ( addition.hasOwnProperty( key ) ) {
                expressionAttributeValues[ ':' + i ] = addition[ key ];
                updateExpressions[ type].push( mapNameToExpressionAttributeName( key ) + ' ' + expression + ' :' + i );
            }

            i++;
        }
    };

    for ( var key in updates ) {
        if ( updates.hasOwnProperty( key ) ) {
            switch( key ) {
                case 'ADD':
                    addToUpdateExpressions( 'ADD', '', updates[ key ] );
                    break;
                case 'REMOVE':
                    addToUpdateExpressions( 'REMOVE', '', updates[ key ] );
                    break;
                case 'SET':
                    addToUpdateExpressions( 'SET', '=', updates[ key ] );
                    break;
                case 'DELETE':
                    addToUpdateExpressions( 'DELETE', '', updates[ key ] );
                    break;
                default:
                    var setExpressions = {};
                    setExpressions[ key ] = updates[ key ];
                    addToUpdateExpressions( 'SET', '=', setExpressions );
                    break;
            }
        }
    }

    var updateExpression = '';

    for ( var key in updateExpressions ) {
        if ( updateExpressions.hasOwnProperty( key ) ) {
            updateExpression += key + ' ' + updateExpressions[ key ].join( ', ' ) + ' ';
        }
    }

    var updateExpressionDefinition = {
        updateExpression: updateExpression,
        expressionAttributeValues: mapJavascriptObjectToDynamoObject( expressionAttributeValues ),
        expressionAttributeNames: expressionAttributeNames
    };

    if ( updateCondition ) {
        var conditionExpression = mapConditionDefinitionToConditionExpression( updateCondition, i + 1, n + 1 );

        updateExpressionDefinition.conditionExpression = conditionExpression.conditionExpression;

        for ( var expressionAttributeNameKey in conditionExpression.expressionAttributeNames ) {
            if ( conditionExpression.expressionAttributeNames.hasOwnProperty( expressionAttributeNameKey ) ) {
                updateExpressionDefinition.expressionAttributeNames[ expressionAttributeNameKey ] = conditionExpression.expressionAttributeNames[ expressionAttributeNameKey ];
            }
        }

        for ( var expressionAttributeValueKey in conditionExpression.expressionAttributeValues ) {
            if ( conditionExpression.expressionAttributeValues.hasOwnProperty( expressionAttributeValueKey ) ) {
                updateExpressionDefinition.expressionAttributeValues[ expressionAttributeValueKey ] = conditionExpression.expressionAttributeValues[ expressionAttributeValueKey ];
            }
        }
    }

    return updateExpressionDefinition;

};

/**
 * @Deprecated
 */
var keyConditionForKeyConditionString = function( condition, keyType ) {

    var conditionParts = condition.split( ' ' );
    var conditionValues = conditionParts.length > 1 ? conditionParts.slice( 1 ) : conditionParts;
    var conditionOperator = conditionParts.length > 1 ? conditionParts[ 0 ] : 'EQ';

    var keyCondition = { AttributeValueList: [] };
    keyCondition.ComparisonOperator = conditionOperator;
    conditionValues.forEach( function( currentConditionValue ) {
        var newKeyCondition = {};
        newKeyCondition[ keyType ] = currentConditionValue;
        keyCondition.AttributeValueList.push( newKeyCondition );

        //TODO: this works for simple types like S, N, and BOOL but will not work for more complex types
    } );

    return keyCondition;

};

var keyConditionExpressionForHashAndRange = function( hashKey, hashValue, rangeKey, range, valueCountStart, nameCountStart ) {

    var conditionDefinition = {};
    conditionDefinition[ hashKey ] = hashValue;

    if ( rangeKey && range ) {
        conditionDefinition[ rangeKey ] = range;
    }

    return mapConditionDefinitionToConditionExpression( conditionDefinition, valueCountStart, nameCountStart );

};

var mapKeySchemaToIndexDefinition = function( keySchema, attributeDefinitions ) {

    var newIndex = {};

    keySchema.forEach( function( currentKeySchema ) {
        if ( currentKeySchema.KeyType === 'HASH' ) {
            newIndex.key = currentKeySchema.AttributeName;
            newIndex.keyType = attributeDefinitions[ currentKeySchema.AttributeName ];
        } else if ( currentKeySchema.KeyType === 'RANGE' ) {
            newIndex.range = currentKeySchema.AttributeName;
            newIndex.rangeType = attributeDefinitions[ currentKeySchema.AttributeName ];
        }
    } );

    return newIndex;

};

/**
 *
 * Usage: var DB = require( 'dynamodb' );
 *        var db = new DB( { accessKeyId: "199238", secretAccessKey: "20390293", region: "east" }, [ { name: "mytable", key: "id", keyType: "S" } ] )
 *
 * Construction will produce a new object containing properties for each table specified.  For instance, after making
 * the above call, you can run get item via the command db.mytable.getItem( '123' ).then( function( item ) { ... } );
 *
 * Get operations map the Dynamo DB item structures to plain JavaScript objects
 * Conversely, put and update operations take plain JavaScript objects and map them to Dynamo DB item structures so you
 * don't need to deal with the matter in your code.
 *
 * The tables accessible via this dynamo driver are configured via the tables input.  An array of table definitions
 * is provided in this input.  Each item may be a String (the name of the table) or a table configuration object.  In
 * the later case the table configuration object is expected to have the following form:
 *
 * {
 *   name: REQUIRED - the name of the DynamoDB table,
 *   alias: OPTIONAL - how the table should be addressed in the resultant object
 * }
 *
 * @param o
 * @param tables List of table names or table configuration objects
 *
 * @constructor
 */
var DynamoDb = function( o, tables ) {
    var options = o || {};
    var self = this;

    if ( ( !o.accessKeyId || !o.secretAccessKey || !o.region ) && !o.db ) {
        throw new Error( 'AWS Access Key ID, Secret Access Key, and Region must all be provided or an existing DB must be provided' );
    }

    if ( options.accessKeyId && options.secretAccessKey && options.region ) {
        AWS.config.update({
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
            region: options.region
        });
    }

    var dynamodb = options.db || new AWS.DynamoDB();

    /**
     * <ul>
     *     <li>name</li>
     *     <li>hash
     *       <ul>
     *           <li>name</li>
     *           <li>type: S|B|N</li>
     *       </ul>
     *     </li>
     *     <li>range
     *       <ul>
     *           <li>name</li>
     *           <li>type: S|B|N</li>
     *       </ul>
     *     </li>
     *     <li>readCapacityUnits: 5</li>
     *     <li>writeCapacityUnits: 5</li>
     * </ul>
     *
     * @param newTableConfiguration
     * @param resolveOnActive
     * @returns {*|promise}
     */
    this.createTable = function( newTableConfiguration, resolveOnActive ) {
        var deferred = Q.defer();

        var awsTableConfiguration = {
            AttributeDefinitions: [ {
                AttributeName: newTableConfiguration.hash.name,
                AttributeType: newTableConfiguration.hash.type
            } ],
            KeySchema: [ {
                AttributeName: newTableConfiguration.hash.name,
                KeyType: "HASH"
            } ],
            ProvisionedThroughput: {
                ReadCapacityUnits: newTableConfiguration.readCapacityUnits || 5,
                WriteCapacityUnits: newTableConfiguration.writeCapacityUnits || 5
            },
            TableName: newTableConfiguration.name
        };

        if ( newTableConfiguration.range ) {
            awsTableConfiguration.AttributeDefinitions.push( {
                AttributeName: newTableConfiguration.range.name,
                AttributeType: newTableConfiguration.range.type
            } );
            awsTableConfiguration.KeySchema.push( {
                AttributeName: newTableConfiguration.range.name,
                KeyType: "RANGE"
            } );
        }

        dynamodb.createTable( awsTableConfiguration, function( err, data ) {
            if ( err ) {
                return deferred.reject( err );
            }

            deferred.resolve( data );
        } );

        return deferred.promise;
    };

    this.describeTable = function( name ) {
        var deferred = Q.defer();
        dynamodb.describeTable( {
            TableName: name
        }, function( err, data ) {
            if (err) {
                return deferred.reject( err );
            }

            return deferred.resolve( data.Table );
        } );
        return deferred.promise;
    };

    tables.forEach( function( currentTableConfiguration ) {

        var currentTable = typeof currentTableConfiguration === 'object' ? currentTableConfiguration.name : currentTableConfiguration;
        var currentTableAlias = typeof currentTableConfiguration === 'object' ? currentTableConfiguration.alias || currentTableConfiguration.name : currentTableConfiguration;

        var tableDefinitionDeferred = Q.defer();
        var tableDefinitionPromise = tableDefinitionDeferred.promise;

        dynamodb.describeTable( {
            TableName: currentTable
        }, function( err, data ) {
            if ( err ) {
                tableDefinitionDeferred.reject( err );
            }
            else {
                var attributeDefinitions = {};
                var secondaryIndices = {};
                var primaryIndex = {};

                data.Table.AttributeDefinitions.forEach( function( currentAttributeDefinition ) {
                    attributeDefinitions[ currentAttributeDefinition.AttributeName ] = currentAttributeDefinition.AttributeType;
                } );

                primaryIndex = mapKeySchemaToIndexDefinition( data.Table.KeySchema, attributeDefinitions );

                if ( data.Table.GlobalSecondaryIndexes ) {
                    data.Table.GlobalSecondaryIndexes.forEach(function (currentGlobalIndex) {
                        secondaryIndices[currentGlobalIndex.IndexName] = mapKeySchemaToIndexDefinition(currentGlobalIndex.KeySchema, attributeDefinitions);
                    });
                }

                if ( data.Table.LocalSecondaryIndexes ) {
                    data.Table.LocalSecondaryIndexes.forEach(function (currentLocalIndex) {
                        secondaryIndices[currentLocalIndex.IndexName] = mapKeySchemaToIndexDefinition(currentLocalIndex.KeySchema, attributeDefinitions);
                    });
                }

                tableDefinitionDeferred.resolve( {
                    name: currentTable,
                    primaryIndex: primaryIndex,
                    secondaryIndices: secondaryIndices
                } );
            }
        } );

        self[ currentTableAlias ] = {
            getItem: function( hash, range ) {

                return tableDefinitionPromise.then( function( tableDefinition ) {

                    var deferred = Q.defer();

                    queryOptions = { Key: {} };
                    queryOptions.Key[ tableDefinition.primaryIndex.key ] = {};
                    queryOptions.Key[ tableDefinition.primaryIndex.key ][ tableDefinition.primaryIndex.keyType ] = hash;

                    if ( tableDefinition.primaryIndex.range ) {
                        if ( !range ) {
                            throw new Error( tableDefinition.name + " requires both a hash and range key but only a hash was provided" );
                        }

                        queryOptions.Key[ tableDefinition.primaryIndex.range ] = {};
                        queryOptions.Key[ tableDefinition.primaryIndex.range ][ tableDefinition.primaryIndex.rangeType ] = range;
                    }

                    queryOptions.TableName = tableDefinition.name;

                    dynamodb.getItem( queryOptions, function( err, data ) {

                        if ( err ) {
                            deferred.reject( err );
                            return;
                        }

                        //TODO: Determine whether this variability is still needed and what its purpose was
                        if ( options.mapResults !== false ) {
                            deferred.resolve( mapDynamoObjectToJavascriptObject( data.Item ) );
                        } else {
                            deferred.resolve( data.Item );
                        }

                    } );

                    return deferred.promise;

                } );

            },

            query: function( hash, range, index ) {

                var executed = false;

                var deferred = Q.defer();

                var queryOptions = {
                    TableName: currentTable,
                    KeyConditionExpression: ""
                };

                var queryable = {
                    limit: function( limit ) {
                        if ( executed ) {
                            throw new Error( "Query may not be modified after execution" );
                        }
                        queryOptions.Limit = limit;
                        return queryable;
                    },
                    filter: function( conditionDefinition ) {
                        if ( executed ) {
                            throw new Error( "Query may not be modified after execution" );
                        }

                        var conditionExpression = mapConditionDefinitionToConditionExpression( conditionDefinition );

                        queryOptions.FilterExpression = conditionExpression.conditionExpression;

                        if ( Object.keys( conditionExpression.expressionAttributeNames).length > 0 ) {
                            queryOptions.ExpressionAttributeNames = conditionExpression.expressionAttributeNames;
                        }
                        if ( Object.keys( conditionExpression.expressionAttributeValues).length > 0 ) {
                            queryOptions.ExpressionAttributeValues = conditionExpression.expressionAttributeValues;
                        }


                        return queryable;
                    },
                    reverse: function() {
                        queryOptions.ScanIndexForward = false;

                        return queryable;
                    },
                    then: function( f ) {
                        if ( !executed ) {

                            executed = true;

                            tableDefinitionPromise.then( function( tableDefinition ) {

                                var queryIndex = tableDefinition.primaryIndex;

                                if ( index ) {
                                    queryIndex = tableDefinition.secondaryIndices[ index ];

                                    queryOptions.IndexName = index;
                                }

                                queryOptions.ExpressionAttributeValues = queryOptions.ExpressionAttributeValues || {};
                                queryOptions.ExpressionAttributeNames = queryOptions.ExpressionAttributeNames || {};

                                var keyConditionExpression = keyConditionExpressionForHashAndRange(
                                    queryIndex.key,
                                    hash,
                                    queryIndex.range,
                                    range,
                                    Object.keys( queryOptions.ExpressionAttributeValues ).length + 1,
                                    Object.keys( queryOptions.ExpressionAttributeNames ).length + 1 );
                                queryOptions.KeyConditionExpression = keyConditionExpression.conditionExpression;

                                Object.keys( keyConditionExpression.expressionAttributeNames ).forEach( function( currentExpressionAttributeName ) {
                                    queryOptions.ExpressionAttributeNames[ currentExpressionAttributeName ] = keyConditionExpression.expressionAttributeNames[ currentExpressionAttributeName ];
                                } );
                                Object.keys( keyConditionExpression.expressionAttributeValues ).forEach( function( currentExpressionAttributeValue ) {
                                    queryOptions.ExpressionAttributeValues[ currentExpressionAttributeValue ] = keyConditionExpression.expressionAttributeValues[ currentExpressionAttributeValue ];
                                } );

                                /*
                                 queryOptions.KeyConditions[ queryIndex.key ] = keyConditionForKeyConditionString( hash, queryIndex.keyType );

                                 if ( range && queryIndex.range ) {
                                 queryOptions.KeyConditions[ queryIndex.range ] = keyConditionForKeyConditionString( range, queryIndex.rangeType );
                                 }
                                 */
                                console.log( 'HI' );
                                console.log( JSON.stringify( queryOptions ) );

                                dynamodb.query( queryOptions, function( err, data ) {

                                    if ( err ) {
                                        deferred.reject( err );
                                        return;
                                    }

                                    //TODO: In cases where the actual result set is larger then the returned result set provide something which we can call to get more results
                                    deferred.resolve( mapDynamoObjectsToJavascriptObjects( data.Items ) );

                                } );

                            } );

                        }

                        return deferred.promise.then( f );
                    }
                };

                return queryable;

            },

            scan: function( conditionDefinition ) {

                var executed = false;

                var deferred = Q.defer();

                var queryOptions = {
                    TableName: currentTable
                };

                var conditionExpression = mapConditionDefinitionToConditionExpression( conditionDefinition );

                if (conditionExpression.conditionExpression) { queryOptions.FilterExpression = conditionExpression.conditionExpression; }
                if (Object.keys(conditionExpression.expressionAttributeNames).length > 0) { queryOptions.ExpressionAttributeNames = conditionExpression.expressionAttributeNames; }
                if (Object.keys(conditionExpression.expressionAttributeValues).length > 0) { queryOptions.ExpressionAttributeValues = conditionExpression.expressionAttributeValues; }

                var scannable = {
                    limit: function( limit ) {
                        if ( executed ) {
                            throw new Error( "Query may not be modified after execution" );
                        }
                        queryOptions.Limit = limit;
                        return scannable;
                    },
                    then: function( f ) {
                        if ( !executed ) {

                            executed = true;

                            tableDefinitionPromise.then( function( tableDefinition ) {

                                dynamodb.scan( queryOptions, function( err, data ) {

                                    if ( err ) {
                                        deferred.reject( err );
                                        return;
                                    }

                                    //TODO: Add consideration here for the case where the results contain both the results and a pointer to the next page of results - the pointer should be something callable or thenable which we can get more results from
                                    deferred.resolve( mapDynamoObjectsToJavascriptObjects( data.Items ) );

                                } );

                            } );

                        }

                        return deferred.promise.then( f );
                    }
                };

                return scannable;

            },

            /**
             *
             * Valid Options
             *
             * <ul>
             *     <li>conditionExpression - a Condition Expression Definition which must resolve to true for the Put to be applied</li>
             *     <li>returnConsumedCapacity - one of INDEXES, TOTAL, or NONE.  Defaults to NONE</li>
             *     <li>returnItemCollectionMetrics - one of SIZE or NONE.  Defaults to NONE</li>
             *     <li>returnValues - one of NONE, ALL_OLD, UPDATED_OLD, ALL_NEW, UPDATED_NEW</li>
             * </ul>
             *
             * @param item Object representing the item to Put.  Required fields follow the attribute requirements of the SDK putItem call
             * @param o Options object - see Valid Options in the description
             * @returns {*}
             */
            putItem: function( item, o ) {

                var options = o || {};

                return tableDefinitionPromise.then( function( tableDefinition ) {
                    var deferred = Q.defer();

                    var queryOptions = {
                        Item: mapJavascriptObjectToDynamoObject( item ),
                        TableName: tableDefinition.name
                    };

                    if ( options.conditionExpression ) {
                        var conditionExpression = mapConditionDefinitionToConditionExpression( options.conditionExpression );

                        queryOptions.ConditionExpression = conditionExpression.conditionExpression;

                        if ( Object.keys( conditionExpression.expressionAttributeNames).length > 0 ) {
                            queryOptions.ExpressionAttributeNames = conditionExpression.expressionAttributeNames;
                        }
                        if ( Object.keys( conditionExpression.expressionAttributeValues).length > 0 ) {
                            queryOptions.ExpressionAttributeValues = conditionExpression.expressionAttributeValues;
                        }
                    }

                    if ( options.returnConsumedCapacity ) {
                        queryOptions.ReturnConsumedCapacity = options.returnConsumedCapacity;
                    }

                    if ( options.returnItemCollectionMetrics ) {
                        queryOptions.ReturnItemCollectionMetrics = options.returnItemCollectionMetrics;
                    }

                    if ( options.returnValues ) {
                        queryOptions.ReturnValues = options.returnValues;
                    }

                    dynamodb.putItem( queryOptions, function( err, data ) {
                        if ( err ) {
                            deferred.reject( err );
                            return;
                        }

                        if ( options.returnValues && options.returnValues !== DynamoDb.valuesOptions.NONE ) {
                            data.item = mapDynamoObjectToJavascriptObject( data.Attributes );
                        }
                        deferred.resolve( data );
                    } );

                    return deferred.promise;
                } );

            },

            deleteItem: function( hash, itemRange ) {

                return tableDefinitionPromise.then( function( tableDefinition ) {

                    var deferred = Q.defer();

                    queryOptions = { Key: {} };
                    queryOptions.Key[ tableDefinition.primaryIndex.key ] = {};
                    queryOptions.Key[ tableDefinition.primaryIndex.key ][ tableDefinition.primaryIndex.keyType ] = hash;

                    if ( tableDefinition.primaryIndex.range ) {
                        if ( !itemRange ) {
                            throw new Error( tableDefinition.name + " requires both a hash and range key but only a hash was provided" );
                        }

                        queryOptions.Key[ tableDefinition.primaryIndex.range ] = {};
                        queryOptions.Key[ tableDefinition.primaryIndex.range ][ tableDefinition.primaryIndex.rangeType ] = itemRange;
                    }

                    queryOptions.TableName = tableDefinition.name;

                    dynamodb.deleteItem( queryOptions, function( err, data ) {
                        if ( err ) {
                            deferred.reject( err );
                            return;
                        }

                        deferred.resolve( data );
                    } );

                    return deferred.promise;

                } );
            },

            /**
             *
             * <h2>Updates Description</h2>
             * <p>The itemUpdates parameter takes an Updates Description object.  This is an objective representation of
             * a DynamoDB Update Expression.  The keys of the object may either be column names or update types.  If a given
             * key is a column name then the value should be the value you wish that column to be set to on the updated
             * row.  If a given key is an update type then the value associated with that key will be based on the type
             * as described below. </p>
             * <dl>
             *     <dt>SET</dt>
             *     <dd>Indicates a SET update should be performed.  This is the default opperation applied to keys wich are
             *     simple column names.  When described explicitly the SET key should be associated with an object whose keys
             *     are the columns names to update and whose values are the values to set the named attribute to.</dd>
             *     <dt>ADD</dt>
             *     <dd>Indicates an ADD update should be performed.  The ADD key should be associated with an object whose
             *     keys are the column names to update and whose values are the values to be added to the named attribute.
             *     NOTE, ADD only supports numeric or set typed attributes.</dd>
             * </dl>
             *
             * @param hash
             * @param itemRange
             * @param itemUpdates
             * @param o
             * @returns {*}
             */
            updateItem: function( hash, itemRange, itemUpdates, o ) {

                var updates = typeof itemRange === 'object' && itemRange != null ? itemRange : itemUpdates;
                var range = typeof itemRange === 'string' || itemRange === null ? itemRange : null;
                var options = ( typeof itemRange === 'string' || itemRange === null ? o : itemUpdates ) || {};

                return tableDefinitionPromise.then( function( tableDefinition ) {

                    var deferred = Q.defer();

                    queryOptions = { Key: {} };
                    queryOptions.Key[ tableDefinition.primaryIndex.key ] = {};
                    queryOptions.Key[ tableDefinition.primaryIndex.key ][ tableDefinition.primaryIndex.keyType ] = hash;

                    if ( tableDefinition.primaryIndex.range ) {
                        if ( !range ) {
                            throw new Error( tableDefinition.name + " requires both a hash and range key but only a hash was provided" );
                        }

                        queryOptions.Key[ tableDefinition.primaryIndex.range ] = {};
                        queryOptions.Key[ tableDefinition.primaryIndex.range ][ tableDefinition.primaryIndex.rangeType ] = range;
                    }

                    queryOptions.TableName = tableDefinition.name;

                    var updateExpression = mapUpdatesToUpdateExpression( updates, options.conditionExpression );

                    queryOptions.UpdateExpression = updateExpression.updateExpression;

                    if ( Object.keys( updateExpression.expressionAttributeValues).length ) {
                        queryOptions.ExpressionAttributeValues = updateExpression.expressionAttributeValues;
                    }
                    if ( Object.keys( updateExpression.expressionAttributeNames).length ) {
                        queryOptions.ExpressionAttributeNames = updateExpression.expressionAttributeNames;
                    }
                    if ( updateExpression.conditionExpression ) {
                        queryOptions.ConditionExpression = updateExpression.conditionExpression;
                    }

                    if ( options.returnConsumedCapacity ) {
                        queryOptions.ReturnConsumedCapacity = options.returnConsumedCapacity;
                    }

                    if ( options.returnItemCollectionMetrics ) {
                        queryOptions.ReturnItemCollectionMetrics = options.returnItemCollectionMetrics;
                    }

                    if ( options.returnValues ) {
                        queryOptions.ReturnValues = options.returnValues;
                    }

                    dynamodb.updateItem( queryOptions, function( err, data ) {
                        if ( err ) {
                            deferred.reject( err );
                            return;
                        }

                        if ( options.returnValues && options.returnValues !== DynamoDb.valuesOptions.NONE ) {
                            data.item = mapDynamoObjectToJavascriptObject( data.Attributes );
                        }
                        deferred.resolve( data );
                    } );

                    return deferred.promise;

                } );
            }
        }
    } );

};


DynamoDb.consumedCapacityOptions = {
    "INEXES": "INDEXES",
    "TOTAL": "TOTAL",
    "NONE": "NONE"
};

DynamoDb.itemCollectionMetricsOptions = {
    "SIZE": "SIZE",
    "NONE": "NONE"
};

DynamoDb.valuesOptions = {
    "NONE": "NONE",
    "ALLOLD": "ALL_OLD",
    "UPDATEDOLD": "UPDATED_OLD",
    "ALLNEW": "ALL_NEW",
    "UPDATEDNEW": "UPDATED_NEW"
};


DynamoDb.mapDynamoObjectToJavascriptObject = mapDynamoObjectToJavascriptObject;
DynamoDb.mapJavascriptObjectToDynamoObject = mapJavascriptObjectToDynamoObject;
DynamoDb.mapConditionDefinitionToConditionExpression = mapConditionDefinitionToConditionExpression;

module.exports = DynamoDb;
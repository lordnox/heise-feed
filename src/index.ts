
import { InMemoryCache } from 'apollo-cache-inmemory'
import { ApolloClient } from 'apollo-client'
import { WebSocketLink } from 'apollo-link-ws'
import { isAfter } from 'date-fns'
import gql from 'graphql-tag'
import * as Parser from 'rss-parser'
import { SubscriptionClient } from 'subscriptions-transport-ws'
import * as ws from 'ws'
import { log } from './services/logger'

const GRAPHQL_SERVER_URI = 'ws://localhost:3421/graphql'

const subscriptionClient = new SubscriptionClient(GRAPHQL_SERVER_URI, { reconnect: true }, ws)

const client = new ApolloClient({
  cache: new InMemoryCache(),
  link: new WebSocketLink(subscriptionClient),
  defaultOptions: {
    watchQuery: {
      fetchPolicy: 'no-cache',
      errorPolicy: 'ignore',
    },
    query: {
      fetchPolicy: 'no-cache',
      errorPolicy: 'all',
    },
  },
})

let running = false

const parser = new Parser()

const getNewestFeedItems = async (old: Date | string) => {
  const feed = await parser.parseURL('https://www.heise.de/rss/heise.rdf')
  const items = feed.items.filter(item => isAfter(item.isoDate, old))
  console.log(items[0])
  return items
}

const checkForNewItems = async () => {
  if(running)
    return triggerError('Already running')
  running = true
  log('Checking for new items')
  const { data } = await client.query({
    query: gql`query {
      link: Link(
        where: { tags_some: { tag: "Heise" }}
        order: datetime_DESC
      ) { datetime }
    }`,
  })
  const datetime: string = data.link ? data.link.datetime : '2000-01-01T00:00:00.000Z'
  log('timestamp: ' + datetime)
  return storeItems(datetime)
}

const triggerEvent = (event: string, data: any) => client.mutate({
  mutation: gql`mutation CreateEvent($event: String!, $data: SequelizeJSON) {
    triggerEvent(name: $event, data: $data)
  }`,
  variables: { event, data },
})

const triggerError = (error: string) => triggerEvent('heise-feed:error', { error })

interface Link {
  url: string
  content?: string
  datetime: Date
  title: string
}

const createLink = async (item: Link) => client.mutate({
  mutation: gql`mutation createLink($title: String!, $url: String!, $date: Date!){
    createLink(data: {
      title: $title
      url: $url
      datetime: $date
      tags: { tag: "Heise" }
    }) { id createdAt }
  }`,
  variables: { title: item.title, url: item.url, date: item.datetime },
})

const storeItems = async (from: Date | string) => {
  const items = await getNewestFeedItems(from)
  await Promise.all(items.map(item => createLink({
    content: item.content,
    datetime: new Date(item.isoDate),
    title: item.title,
    url: item.link,
  })))
  triggerEvent('heise-feed:result', { items: items.length, from })
  running = false
}

const observer = client.subscribe({
  query: gql`subscription { event: eventListener(name: "*") { name }}`,
})

log('observer started')
observer
.filter(({ data: { event } }) => event.name.startsWith('heise-feed:'))
.map(({ data: { event, data } }) => ({ event: event.name.slice(11), data }))
.forEach(({ event, data }) => {
  log(event, data)
  if(event === 'start') return checkForNewItems()
  // if(event.name === 'heise-feed')
  return true
})
